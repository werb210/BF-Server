// BF_SERVER_BI_CARRIER_v74
// When a client accepts a term sheet, their PGI application should go to the
// carrier. It never did - confirm-acceptance fired a SignNow envelope and
// stopped there, so every accepted deal with PGI needed someone to remember to
// submit the insurance side by hand.
//
// bi-server already owns carrier dispatch end to end:
//   POST /api/v1/bi/application/:id/submit-pgi -> submitApplicationToPGI()
// which validates, checks assertDocsReadyForCarrier, and talks to the carrier.
// So this is a call, not a reimplementation.
//
// Same service-JWT pattern as biDocMirror, deliberately: one auth path between
// the silos rather than two that can drift.
import { signServiceToken } from "../auth/serviceTokens.js"; // BF_SERVER_v789_SERVICE_TOKENS
import { pool } from "../db.js";
import { logError, logInfo } from "../observability/logger.js";

// BF_SERVER_v784_BI_CARRIER - the old call went to /api/application/:id/submit-pgi
// on a host BI does not run on, with a token BI does not accept. BI serves
// POST /api/v1/bi/application/:id/submit-pgi (BI's own API, hence /v1/) keyed
// by BI's internal id, which BF does not store - so resolve it first through
// BI's read-only pgi-readiness lookup, exactly as pgiStage.ts does.
function biBaseUrl(): string {
  return (process.env.BI_SERVER_URL || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net").replace(/\/+$/, "");
}

// BF_SERVER_v789_SERVICE_TOKENS - both tokens come from the shared helper
// (iss "bf-server", aud "bi-server", BI_SERVICE_JWT_SECRET when set). The helper
// throws when no key is configured, as getSecret did.
export function mintServiceJwt(): string {
  return signServiceToken("bi-server", { source: "bf-server", claims: { service: "bf-server" } });
}

// BI's Maya read routes accept source 'maya-service' only (see mayaStaff.ts).
function mintLookupJwt(): string {
  return signServiceToken("bi-server", { source: "maya-service" });
}

async function lookupBiInternalId(publicId: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(`${biBaseUrl()}/api/v1/bi/maya/staff/pgi-readiness`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${mintLookupJwt()}` },
      body: JSON.stringify({ public_id: publicId }),
      signal: controller.signal,
    });
    const body: any = await resp.json().catch((err) => {
      logError("bi_carrier_lookup_parse_failed", { publicId, error: String(err) });
      return null;
    });
    if (!resp.ok || !body?.ok) return null;
    const r = body.result ?? {};
    const id = r.applicationId ?? r.application_id ?? r.id ?? r.application?.id ?? null;
    return id == null || id === "" ? null : String(id);
  } finally {
    clearTimeout(timer);
  }
}

export type CarrierSubmitResult =
  | { ok: true; skipped: "no_pgi" }
  | { ok: true; externalId: string | null; status: string | null }
  | { ok: false; reason: string };

/**
 * Submits the BI application linked to a BF application to the carrier.
 *
 * Returns skipped rather than failing when the applicant did not opt into PGI -
 * most applications have no insurance side and that is not an error.
 */
export async function submitBiToCarrier(bfApplicationId: string): Promise<CarrierSubmitResult> {
  let publicId: string | null = null;
  try {
    const r = await pool.query<{ bi_public_id: string | null }>(
      `SELECT bi_public_id FROM applications WHERE id::text = $1 LIMIT 1`,
      [bfApplicationId],
    );
    publicId = r.rows[0]?.bi_public_id ?? null;
  } catch (err) {
    logError("bi_carrier_lookup_failed", { bfApplicationId, error: String(err) });
    return { ok: false, reason: "lookup_failed" };
  }

  // No BI application means the applicant declined PGI at Step 6. Expected.
  if (!publicId) return { ok: true, skipped: "no_pgi" };

  let biId: string | null = null;
  try {
    biId = await lookupBiInternalId(publicId);
  } catch (err) {
    logError("bi_carrier_bi_lookup_failed", { bfApplicationId, publicId, error: String(err) });
    return { ok: false, reason: "bi_lookup_failed" };
  }
  if (!biId) {
    logError("bi_carrier_bi_id_missing", { bfApplicationId, publicId });
    return { ok: false, reason: "bi_id_not_found" };
  }

  const url = `${biBaseUrl()}/api/v1/bi/application/${encodeURIComponent(biId)}/submit-pgi`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mintServiceJwt()}`,
      },
      body: JSON.stringify({ source: "bf_offer_accepted" }),
      signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      // bi-server rejects when docs are not ready - assertDocsReadyForCarrier.
      // That is a real state, not a fault, and staff need to see it rather than
      // have it disappear into a log.
      logError("bi_carrier_submit_rejected", {
        bfApplicationId, publicId, status: r.status, body: text.slice(0, 500),
      });
      return { ok: false, reason: `bi_${r.status}` };
    }
    let parsed: { externalId?: string; status?: string } = {};
    try { parsed = JSON.parse(text); } catch { /* body is not json; the 2xx still counts */ }
    logInfo("bi_carrier_submitted", { bfApplicationId, publicId, status: parsed.status ?? null });
    return { ok: true, externalId: parsed.externalId ?? null, status: parsed.status ?? null };
  } catch (err) {
    logError("bi_carrier_submit_failed", { bfApplicationId, publicId, error: String(err) });
    return { ok: false, reason: "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}
