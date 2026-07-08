// BF_SERVER_LINKEDIN_CONVERSIONS_v1 - closed-loop: when a BF application funds
// (pipeline_state Accepted/Funded) and carries a LinkedIn click id (li_fat_id),
// stream it to the LinkedIn Conversions API (/rest/conversionEvents) as an
// offline conversion on the configured conversion rule, with the deal size as
// the value, so LinkedIn optimizes toward profitable clients. li_fat_id
// (LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID) is LinkedIn's own click id (not PII),
// so this runs under implied consent. Env-gated and failure-safe: an
// application is only marked uploaded on success.
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const REST_BASE = "https://api.linkedin.com/rest";
const API_VERSION = String(process.env.LINKEDIN_API_VERSION || "202605");
const FUNDED_STATES = ["Accepted", "Funded"];

export function linkedInConversionsConfigured(): boolean {
  return Boolean(
    process.env.LINKEDIN_ADS_CLIENT_ID &&
    process.env.LINKEDIN_ADS_CLIENT_SECRET &&
    process.env.LINKEDIN_ADS_REFRESH_TOKEN &&
    process.env.LINKEDIN_ADS_ACCOUNT_ID &&
    process.env.LINKEDIN_CONVERSION_URN,
  );
}

// Accept either a full conversion-rule URN or a bare numeric id.
function conversionUrn(): string {
  const raw = String(process.env.LINKEDIN_CONVERSION_URN || "").trim();
  if (/^\d+$/.test(raw)) return `urn:lla:llaPartnerConversion:${raw}`;
  return raw;
}

export type PendingLiConversion = { applicationId: string; liFatId: string; value: number; fundedAt: string };

export async function findPendingLinkedInConversions(limit = 200): Promise<PendingLiConversion[]> {
  const { rows } = await pool.query<{ id: string; li_fat_id: string; value: string | null; funded_at: string }>(
    `SELECT id,
            metadata->'attribution'->>'li_fat_id' AS li_fat_id,
            COALESCE(funded_amount, requested_amount) AS value, -- BF_SERVER_FUNDED_AMOUNT_v1
            COALESCE(updated_at, now())::text AS funded_at
       FROM applications
      WHERE silo = 'BF'
        AND pipeline_state = ANY($1)
        AND COALESCE(metadata->'attribution'->>'li_fat_id', '') <> ''
        AND (metadata->'li_conversion_uploaded_at') IS NULL
      ORDER BY updated_at DESC
      LIMIT $2`,
    [FUNDED_STATES, limit],
  );
  return rows.map((r) => ({ applicationId: r.id, liFatId: String(r.li_fat_id), value: Number(r.value ?? 0), fundedAt: r.funded_at }));
}

let tokenCache: { token: string; expiresAt: number } | null = null;
async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: String(process.env.LINKEDIN_ADS_REFRESH_TOKEN),
    client_id: String(process.env.LINKEDIN_ADS_CLIENT_ID),
    client_secret: String(process.env.LINKEDIN_ADS_CLIENT_SECRET),
  });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`linkedin_ads_token_failed status=${r.status}`);
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  const token = String(j.access_token ?? "");
  if (!token) throw new Error("linkedin_ads_token_empty");
  tokenCache = { token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return token;
}

function happenedAtMs(iso: string): number {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

// Stream one funded deal. Returns true on success.
async function uploadOne(p: PendingLiConversion): Promise<boolean> {
  const token = await accessToken();
  const currency = process.env.LINKEDIN_ADS_CURRENCY || "CAD";
  const payload: Record<string, unknown> = {
    conversion: conversionUrn(),
    conversionHappenedAt: happenedAtMs(p.fundedAt),
    eventId: p.applicationId,
    user: { userIds: [{ idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: p.liFatId }] },
  };
  if (p.value > 0) payload.conversionValue = { currencyCode: currency, amount: String(p.value) };
  const resp = await fetch(`${REST_BASE}/conversionEvents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Linkedin-Version": API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    logError("linkedin_conversion_http_failed", { status: resp.status });
    console.warn("[li_conversion] http", resp.status, text);
    return false;
  }
  return true;
}

export async function uploadFundedLinkedInConversions(): Promise<{ configured: boolean; uploaded: number; failed: number; pending: number }> {
  if (!linkedInConversionsConfigured()) return { configured: false, uploaded: 0, failed: 0, pending: 0 };
  const pendingList = await findPendingLinkedInConversions();
  let uploaded = 0, failed = 0;
  for (const p of pendingList) {
    try {
      const ok = await uploadOne(p);
      if (!ok) { failed++; continue; }
      await pool.query(
        `UPDATE applications
            SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('li_conversion_uploaded_at', now()::text),
                updated_at = now()
          WHERE id = $1`,
        [p.applicationId],
      );
      uploaded++;
    } catch (e) {
      failed++;
      logError("linkedin_conversion_upload_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { configured: true, uploaded, failed, pending: Math.max(0, pendingList.length - uploaded - failed) };
}
