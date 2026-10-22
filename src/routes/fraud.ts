// BF_SERVER_v846_FRAUD - the fraud-protection API for the staff portal (ported from Keystone; all 15 checks, no plans).
//   GET  /api/fraud/applications/:id              Admin, Staff: every check, per-document badges, score
//   POST /api/fraud/applications/:id/run          Admin, Staff: run the checks again now (202)
//   GET  /api/fraud/applications/:id/network      Admin, Staff: the network graph (masked labels, same silo only)
//   GET  /api/fraud/applications/:id/prescreen    Admin, Staff: the pre-screen summary text
//   PUT  /api/fraud/applications/:id/prescreen    Admin, Staff: { include_in_package: boolean }
//   GET  /api/fraud/settings                      Admin: watchlist opt-in, pre-screen default, which services are set up
//   PUT  /api/fraud/settings                      Admin: { watchlist_opt_in?, include_prescreen_in_package? }
//   GET  /api/fraud/staff-alerts                  Admin: recent inside-job events
// Fraud data is per application. Every application route answers 404 when the file is not in the caller's silo
// (X-Silo / ?silo=, resolved by auth), like the neighbouring /api/portal application routes.
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";
import type { Q } from "../fraud/types.js";
import { FRAUD_CHECKS } from "../fraud/catalogue.js";
import { allowedChecks, enqueueFraudRun, getFraudSettings, listResults, queueStatus, saveFraudSettings } from "../fraud/store.js";
import { computeScore, prescreenText } from "../fraud/score.js";
import { buildNetwork, loadProfile } from "../fraud/engine.js";
import { sameSiloNetwork } from "../fraud/network.js";
import { fraudProviders, providerStatus } from "../fraud/providers/index.js";
import { watchlistReady } from "../fraud/watchlist.js";
import { postToOps } from "../fraud/opsLink.js";

export const FRAUD_COMPANY_NAME = "Boreal Financial";

const router = Router();
const db = () => pool as unknown as Q;
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const userIdOf = (req: any) => String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");

type AppRow = { id: string; name: string | null; include: boolean | null; silo: string | null };

/** The application, when it exists in the caller's silo. */
async function appInSilo(id: string, res: any): Promise<AppRow | null> {
  const silo = getSilo(res) ?? null;
  const r = await db().query(
    `SELECT id::text AS id, COALESCE(business_legal_name, name) AS name, fraud_prescreen_in_package AS include, silo
       FROM applications
      WHERE id::text = $1 AND ($2::text IS NULL OR silo IS NULL OR upper(silo) = upper($2::text)) LIMIT 1`,
    [id, silo],
  );
  return (r.rows[0] as AppRow | undefined) ?? null;
}

router.get("/applications/:id", ...staff, safeHandler(async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const app = await appInSilo(String(req.params.id), res);
  if (!app) return res.status(404).json({ ok: false, error: "not_found" });
  const allowed = allowedChecks();
  const rows = await listResults(db(), app.id);
  const docs = await db().query(
    `SELECT id::text AS id, COALESCE(display_name, filename, title) AS filename, COALESCE(category, document_type) AS category
       FROM documents WHERE application_id::text = $1 ORDER BY created_at ASC`,
    [app.id],
  );
  const checks = FRAUD_CHECKS.map((c) => {
    const r = rows.find((x) => x.check_key === c.key && x.subject === "");
    return {
      key: c.key, label: c.label, description: c.description, scope: c.scope,
      ...(r ? { status: r.status, reasons: r.reasons, checked_at: r.checked_at, provider: r.provider } : { status: c.scope === "document" ? "per_document" : "pending" }),
    };
  });
  const documents = docs.rows.map((d: any) => {
    const tamper = rows.find((r) => r.check_key === "fraud_1" && r.subject === d.id);
    const math = rows.find((r) => r.check_key === "fraud_2" && r.subject === d.id);
    return {
      document_id: d.id, filename: d.filename, category: d.category,
      tamper: tamper ? { status: tamper.status, reasons: tamper.reasons, checked_at: tamper.checked_at } : null,
      statement_math: math ? { status: math.status, reasons: math.reasons, checked_at: math.checked_at } : null,
    };
  });
  return res.json({
    ok: true, application_id: app.id, silo: app.silo, checks, documents, score: computeScore(rows, allowed),
    include_prescreen_in_package: app.include ?? (await getFraudSettings(db())).include_prescreen_in_package,
    queue: await queueStatus(db(), app.id),
  });
}));

router.post("/applications/:id/run", ...staff, safeHandler(async (req: any, res) => {
  const app = await appInSilo(String(req.params.id), res);
  if (!app) return res.status(404).json({ ok: false, error: "not_found" });
  await enqueueFraudRun(db(), app.id, "staff_request");
  return res.status(202).json({ ok: true, queued: true });
}));

router.get("/applications/:id/network", ...staff, safeHandler(async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const app = await appInSilo(String(req.params.id), res);
  const p = app ? await loadProfile(db(), app.id) : null;
  if (!app || !p) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true, network: await sameSiloNetwork(db(), await buildNetwork(db(), p), app.silo) });
}));

router.get("/applications/:id/prescreen", ...staff, safeHandler(async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const app = await appInSilo(String(req.params.id), res);
  if (!app) return res.status(404).json({ ok: false, error: "not_found" });
  const s = computeScore(await listResults(db(), app.id), allowedChecks());
  const include = app.include ?? (await getFraudSettings(db())).include_prescreen_in_package;
  return res.json({ ok: true, score: s, include_in_package: include, lines: prescreenText(s, { company: FRAUD_COMPANY_NAME, applicationName: app.name, at: new Date() }) });
}));

router.put("/applications/:id/prescreen", ...staff, safeHandler(async (req: any, res) => {
  if (typeof req.body?.include_in_package !== "boolean") return res.status(400).json({ ok: false, error: "include_in_package must be true or false" });
  const app = await appInSilo(String(req.params.id), res);
  if (!app) return res.status(404).json({ ok: false, error: "not_found" });
  await db().query(`UPDATE applications SET fraud_prescreen_in_package = $2 WHERE id::text = $1`, [app.id, req.body.include_in_package]);
  return res.json({ ok: true, include_in_package: req.body.include_in_package });
}));

router.get("/settings", ...admin, safeHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const ready = watchlistReady();
  return res.json({
    ok: true,
    settings: await getFraudSettings(db()),
    watchlist: { ready: ready.ok, why: ready.ok ? null : ready.why },
    services: providerStatus(fraudProviders()),
  });
}));

router.put("/settings", ...admin, safeHandler(async (req: any, res) => {
  const b = req.body ?? {};
  const patch: { watchlist_opt_in?: boolean; include_prescreen_in_package?: boolean } = {};
  if (b.watchlist_opt_in !== undefined) {
    if (typeof b.watchlist_opt_in !== "boolean") return res.status(400).json({ ok: false, error: "watchlist_opt_in must be true or false" });
    if (b.watchlist_opt_in && !watchlistReady().ok) return res.status(409).json({ ok: false, error: "watchlist_not_set_up" });
    patch.watchlist_opt_in = b.watchlist_opt_in;
  }
  if (b.include_prescreen_in_package !== undefined) {
    if (typeof b.include_prescreen_in_package !== "boolean") return res.status(400).json({ ok: false, error: "include_prescreen_in_package must be true or false" });
    patch.include_prescreen_in_package = b.include_prescreen_in_package;
  }
  const before = await getFraudSettings(db());
  const settings = await saveFraudSettings(db(), patch, userIdOf(req));
  let ops: { told: boolean; error: string | null } = { told: false, error: null };
  if (patch.watchlist_opt_in !== undefined && patch.watchlist_opt_in !== before.watchlist_opt_in) {
    // Opting out also asks Keystone operations to delete every hash Boreal shared.
    const r = await postToOps("watchlist/opt-in", { opt_in: patch.watchlist_opt_in });
    ops = { told: r.ok, error: r.ok ? null : r.error };
    if (!r.ok) console.warn("[fraud] watchlist opt-in change not delivered to Keystone operations", { error: r.error });
    if (r.ok && !patch.watchlist_opt_in) await db().query(`UPDATE fraud_watchlist_shares SET withdrawn_at = now() WHERE withdrawn_at IS NULL`, []);
  }
  return res.json({ ok: true, settings, ops });
}));

router.get("/staff-alerts", ...admin, safeHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const r = await db().query(
    `SELECT e.id, e.kind, e.severity, e.application_id, e.detail, e.created_at, e.alerted_at,
            COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) AS staff_name
       FROM staff_risk_events e LEFT JOIN users u ON u.id::text = e.user_id
      WHERE e.severity IN ('amber', 'red') ORDER BY e.created_at DESC LIMIT 100`,
    [],
  );
  return res.json({ ok: true, alerts: r.rows });
}));

export default router;
