// BF_SERVER_ADS_AUDIENCES_v708 - consented funded / qualified BF clients go to
// Customer Match lists via Data Manager (the Google Ads API path closed 2026-04-01).
// Hashed email + phone only, once per person per list. No-op until
// GOOGLE_ADS_CM_FUNDED_LIST_ID / GOOGLE_ADS_CM_QUALIFIED_LIST_ID are set.
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";
import { accessToken } from "./googleAdsConversions.js";
import { userIdentifiersFor, type UserIdentifier } from "./googleAdsEnhanced.js";
import { QUALIFIED_STATES } from "./googleAdsLeadSignals.js";

export const DATA_MANAGER_AUDIENCE_URL = "https://datamanager.googleapis.com/v1/audienceMembers:ingest";
const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");
const BATCH = 500;

export type AudienceKind = "funded" | "qualified";
export function audienceLists(): Array<{ kind: AudienceKind; listId: string }> {
  const out: Array<{ kind: AudienceKind; listId: string }> = [];
  const funded = digits(process.env.GOOGLE_ADS_CM_FUNDED_LIST_ID);
  const qualified = digits(process.env.GOOGLE_ADS_CM_QUALIFIED_LIST_ID);
  if (funded) out.push({ kind: "funded", listId: funded });
  if (qualified) out.push({ kind: "qualified", listId: qualified });
  return out;
}

export function buildAudienceBody(listId: string, members: UserIdentifier[][], validateOnly = false) {
  const customerId = digits(process.env.GOOGLE_ADS_CUSTOMER_ID);
  const loginId = digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || customerId;
  return {
    destinations: [{
      operatingAccount: { accountType: "GOOGLE_ADS", accountId: customerId },
      loginAccount: { accountType: "GOOGLE_ADS", accountId: loginId },
      productDestinationId: digits(listId),
    }],
    audienceMembers: members.map((ids) => ({
      userData: { userIdentifiers: ids.map((u) => ("hashedEmail" in u ? { emailAddress: u.hashedEmail } : { phoneNumber: u.hashedPhoneNumber })) },
      consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_GRANTED" },
    })),
    termsOfService: { customerMatchTermsOfServiceStatus: "ACCEPTED" },
    encoding: "HEX",
    validateOnly,
  };
}

const STATE_SQL: Record<AudienceKind, string> = {
  funded: "(a.funded_at IS NOT NULL OR a.pipeline_state IN ('Accepted','Funded'))",
  qualified: "lower(COALESCE(a.pipeline_state,'')) = ANY($2)",
};

async function candidates(kind: AudienceKind, listId: string): Promise<Array<{ contactId: string; ids: UserIdentifier[] }>> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.id) c.id::text AS contact_id, c.email, c.phone,
            COALESCE(a.metadata->'formData'->>'ad_measurement_consent', a.metadata->>'ad_measurement_consent') AS consent
       FROM applications a
       JOIN contacts c ON c.id = a.contact_id
      WHERE a.silo = 'BF' AND ${STATE_SQL[kind]}
        AND NOT EXISTS (SELECT 1 FROM ads_audience_members m WHERE m.list_id = $1 AND m.contact_id = c.id::text)
      ORDER BY c.id, a.updated_at DESC
      LIMIT 5000`,
    kind === "qualified" ? [listId, QUALIFIED_STATES] : [listId],
  );
  return rows
    .map((r: any) => ({ contactId: String(r.contact_id), ids: userIdentifiersFor(r.email, r.phone, r.consent) }))
    .filter((r) => r.ids.length > 0);
}

export async function syncAudiencesViaDataManager(fetchImpl: typeof fetch = fetch): Promise<Record<string, { sent: number; failed: number; detail?: string }>> {
  const out: Record<string, { sent: number; failed: number; detail?: string }> = {};
  for (const { kind, listId } of audienceLists()) {
    const result = { sent: 0, failed: 0 } as { sent: number; failed: number; detail?: string };
    out[kind] = result;
    try {
      const people = await candidates(kind, listId);
      for (let i = 0; i < people.length; i += BATCH) {
        const batch = people.slice(i, i + BATCH);
        const token = await accessToken();
        const resp = await fetchImpl(DATA_MANAGER_AUDIENCE_URL, {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify(buildAudienceBody(listId, batch.map((p) => p.ids))),
        });
        if (!resp.ok) {
          result.failed += batch.length;
          result.detail = (await resp.text().catch(() => "")).slice(0, 300);
          logError("google_audience_upload_failed", { kind, status: resp.status, detail: result.detail });
          break;
        }
        for (const p of batch) {
          await pool.query(
            "INSERT INTO ads_audience_members (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [listId, p.contactId],
          );
        }
        result.sent += batch.length;
      }
    } catch (err: any) {
      result.detail = String(err?.message ?? err).slice(0, 300);
      logError("google_audience_sync_failed", { kind, message: result.detail });
    }
  }
  return out;
}
