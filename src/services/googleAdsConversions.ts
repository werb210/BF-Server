// BF_SERVER_GOOGLE_ADS_CONVERSIONS_v1 - closed-loop: when a BF application funds
// (pipeline_state Accepted/Funded) and carries a Google click id (gclid), upload
// it to Google Ads as an offline conversion with the deal size as the value, so
// Smart Bidding optimizes toward profitable clients. gclid-keyed uploads are NOT
// a PII upload (gclid is Google's own click id), so they run under implied
// consent; the hashed-email path (PII) is deferred until express consent exists.
// Env-gated and failure-safe: an application is only marked uploaded on success.
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";

const API_VERSION = "v18";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FUNDED_STATES = ["Accepted", "Funded"];

export function conversionsConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID &&
    process.env.GOOGLE_ADS_CONVERSION_ACTION_ID,
  );
}

export type PendingConversion = { applicationId: string; gclid: string; value: number; fundedAt: string };

export async function findPendingConversions(limit = 200): Promise<PendingConversion[]> {
  const { rows } = await pool.query<{ id: string; gclid: string; value: string | null; funded_at: string }>(
    `SELECT id,
            metadata->'attribution'->>'gclid' AS gclid,
            requested_amount AS value,
            COALESCE(updated_at, now())::text AS funded_at
       FROM applications
      WHERE silo = 'BF'
        AND pipeline_state = ANY($1)
        AND COALESCE(metadata->'attribution'->>'gclid', '') <> ''
        AND (metadata->'ad_conversion_uploaded_at') IS NULL
      ORDER BY updated_at DESC
      LIMIT $2`,
    [FUNDED_STATES, limit],
  );
  return rows.map((r) => ({ applicationId: r.id, gclid: String(r.gclid), value: Number(r.value ?? 0), fundedAt: r.funded_at }));
}

let tokenCache: { token: string; expiresAt: number } | null = null;
async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: String(process.env.GOOGLE_ADS_CLIENT_ID),
    client_secret: String(process.env.GOOGLE_ADS_CLIENT_SECRET),
    refresh_token: String(process.env.GOOGLE_ADS_REFRESH_TOKEN),
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`google_ads_token_failed status=${r.status}`);
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  const token = String(j.access_token ?? "");
  if (!token) throw new Error("google_ads_token_empty");
  tokenCache = { token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return token;
}

function cid(): string { return String(process.env.GOOGLE_ADS_CUSTOMER_ID).replace(/[^0-9]/g, ""); }
function fmtDateTime(iso: string): string {
  // Google wants "yyyy-MM-dd HH:mm:ss+00:00"
  const d = new Date(iso);
  const s = (isNaN(d.getTime()) ? new Date() : d).toISOString(); // 2026-06-26T12:00:00.000Z
  return s.slice(0, 19).replace("T", " ") + "+00:00";
}

// Upload one funded deal. Returns true on success (or partial-failure-free ack).
async function uploadOne(p: PendingConversion): Promise<boolean> {
  const token = await accessToken();
  const customerId = cid();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
    "Content-Type": "application/json",
  };
  const lc = String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "").replace(/[^0-9]/g, "");
  if (lc) headers["login-customer-id"] = lc;
  const payload = {
    conversions: [{
      gclid: p.gclid,
      conversionAction: `customers/${customerId}/conversionActions/${String(process.env.GOOGLE_ADS_CONVERSION_ACTION_ID).replace(/[^0-9]/g, "")}`,
      conversionDateTime: fmtDateTime(p.fundedAt),
      ...(p.value > 0 ? { conversionValue: p.value, currencyCode: process.env.GOOGLE_ADS_CURRENCY || "CAD" } : {}),
      orderId: p.applicationId,
      consent: { adUserData: "GRANTED", adPersonalization: "GRANTED" },
    }],
    partialFailure: true,
  };
  const resp = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}:uploadClickConversions`, {
    method: "POST", headers, body: JSON.stringify(payload),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) { logError("google_ads_conversion_http_failed"); console.warn("[ads_conversion] http", resp.status, text.slice(0, 300)); return false; }
  // partialFailureError present => this row failed validation
  let body: any = {}; try { body = JSON.parse(text); } catch { /* ignore */ }
  if (body?.partialFailureError) { console.warn("[ads_conversion] partial_failure", JSON.stringify(body.partialFailureError).slice(0, 300)); return false; }
  return true;
}

export async function uploadFundedConversions(): Promise<{ configured: boolean; uploaded: number; failed: number; pending: number }> {
  if (!conversionsConfigured()) return { configured: false, uploaded: 0, failed: 0, pending: 0 };
  const pendingList = await findPendingConversions();
  let uploaded = 0, failed = 0;
  for (const p of pendingList) {
    try {
      const ok = await uploadOne(p);
      if (!ok) { failed++; continue; }
      await pool.query(
        `UPDATE applications
            SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
                  'ad_conversion_uploaded_at', now()::text),
                updated_at = now()
          WHERE id = $1`,
        [p.applicationId],
      );
      uploaded++;
    } catch (e) {
      failed++; logError("google_ads_conversion_upload_failed");
    }
  }
  return { configured: true, uploaded, failed, pending: Math.max(0, pendingList.length - uploaded - failed) };
}
