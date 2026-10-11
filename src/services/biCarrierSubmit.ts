// BF_SERVER_BI_CARRIER_v74
// When a client accepts a term sheet, their PGI application should go to the
// carrier. It never did - confirm-acceptance fired a SignNow envelope and
// stopped there, so every accepted deal with PGI needed someone to remember to
// submit the insurance side by hand.
//
// bi-server already owns carrier dispatch end to end:
//   POST /api/v1/bi/application/:id/submit-pgi -> submitApplicationToPGI()
// (BI-Server src/routes/biApplicationRoutes.ts, behind BI requireAuth). Its :id
// is the BI-internal bi_applications.id, which BF never stores (BF keeps the
// BI public_id and application code), so the id is resolved first through
// BI's read-only pgi-readiness lookup, which accepts a public_id.
// which validates, checks assertDocsReadyForCarrier, and talks to the carrier.
// So this is a call, not a reimplementation.
//
// Same service-JWT pattern as biDocMirror, deliberately: one auth path between
// the silos rather than two that can drift.
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { logError, logInfo } from "../observability/logger.js";

// BF_SERVER_BI_CARRIER_PATH_FIX_v1 - the old fallback host and path did not
// exist (404 on every accepted deal). Same host as every other BF -> BI call.
const BI_SERVER_URL =
  process.env.BI_SERVER_URL || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net";

function getSecret(): string {
  const s = process.env.JWT_SECRET || "";
  if (!s) throw new Error("jwt_secret_missing");
  return s;
}

// Cross-repo contract: BF-Server -> BI-Server staff routes use a service token
// { kind: "service", service: "bf-server" } signed with the shared JWT_SECRET.
// `source` is kept for BI code that still reads it (same as biDocMirror).
function mintServiceJwt(): string {
  return jwt.sign({ kind: "service", service: "bf-server", source: "bf-server" }, getSecret(), { algorithm: "HS256", expiresIn: "5m" });
}

// BI's pgi-readiness lookup only admits Maya service tokens (source maya-service),
// the same token BF's pgiStage.ts already uses for that endpoint.
async function resolveBiApplicationId(publicId: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const token = jwt.sign({ kind: "service", service: "bf-server", source: "maya-service" }, getSecret(), { algorithm: "HS256", expiresIn: "5m" });
    const r = await fetch(`${BI_SERVER_URL.replace(/\/+$/, "")}/api/v1/bi/maya/staff/pgi-readiness`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ public_id: publicId }),
      signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      logError("bi_carrier_resolve_failed", { publicId, status: r.status, body: text.slice(0, 300) });
      return null;
    }
    const parsed = JSON.parse(text) as { result?: { applicationId?: unknown } };
    const id = parsed?.result?.applicationId;
    return typeof id === "string" && id ? id : null;
  } catch (err) {
    logError("bi_carrier_resolve_failed", { publicId, error: String(err) });
    return null;
  } finally {
    clearTimeout(timeout);
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

  const biApplicationId = await resolveBiApplicationId(publicId);
  if (!biApplicationId) {
    logError("bi_carrier_submit_rejected", { bfApplicationId, publicId, status: null, body: "BI application id could not be resolved from public_id" });
    return { ok: false, reason: "bi_application_unresolved" };
  }

  const url = `${BI_SERVER_URL.replace(/\/+$/, "")}/api/v1/bi/application/${encodeURIComponent(biApplicationId)}/submit-pgi`;
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
