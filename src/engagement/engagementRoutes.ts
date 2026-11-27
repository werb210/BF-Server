// BF_SERVER_ENGAGEMENT_v1 - staff API for outreach tracking in the BF-Server CRMs (Keystone > Marketing > Outreach). The
// business comes from X-Silo like the rest of /api/crm. Mounted at /api/crm/engagement behind requireAuth. Same shape as
// BI-Server's /api/v1/bi/engagement, so the portal uses one screen for both.
import express, { type Request, type Response } from "express";
import { pool } from "../db.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { STAGES, board, contactDetail, funnel, getSettings, queue, recordEvent, saveSettings, stageLabels, type EventKind } from "./engagement.js";
import { REPLY_KIND_LABEL } from "./classifyReply.js";

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAdmin = (req: Request) => ["admin", "owner"].includes(String((req as any).user?.role ?? "").toLowerCase());
const actor = (req: Request) => String((req as any).user?.name ?? (req as any).user?.email ?? "Staff");
const s = (v: unknown, max = 200) => { const t = String(v ?? "").trim().slice(0, max); return t || null; };
const silo = (req: Request) => String(resolveSiloFromRequest(req as any) ?? "BF").toUpperCase();
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((err) => {
    console.error("[engagement] route failed", { path: req.path, message: (err as Error)?.message });
    if (!res.headersSent) res.status(500).json({ ok: false, error: "internal_error" });
  });
};
const filters = (req: Request) => ({
  silo: silo(req),
  flowId: UUID.test(String(req.query.flow ?? "")) ? String(req.query.flow) : null,
  owner: s(req.query.owner, 80),
  q: s(req.query.q, 100),
});

router.get("/meta", (req, res) => {
  const labels = stageLabels(silo(req));
  res.json({ ok: true, brand: silo(req), stages: [...STAGES, "lost"].map((k) => ({ key: k, label: labels[k as keyof typeof labels] })), replyKinds: REPLY_KIND_LABEL });
});
router.get("/board", wrap(async (req, res) => res.json({ ok: true, stages: await board(pool, filters(req)) })));
router.get("/queue", wrap(async (req, res) => res.json({ ok: true, items: await queue(pool, filters(req)) })));
router.get("/funnel", wrap(async (req, res) => {
  const days = Number(req.query.days);
  const since = Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86_400_000) : null;
  res.json({ ok: true, ...(await funnel(pool, silo(req), since)) });
}));
router.get("/contacts/:id", wrap(async (req, res) => {
  if (!UUID.test(String(req.params.id))) return res.status(400).json({ ok: false, error: "invalid_id" });
  const d = await contactDetail(pool, silo(req), String(req.params.id));
  if (!d) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, contact: d });
}));
const ACTIONS: EventKind[] = ["followed_up", "met", "no_show", "booked", "lost", "reopen", "signed_up", "reply_kind", "requeue"];
router.post("/contacts/:id/action", wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  const action = String(req.body?.action ?? "") as EventKind;
  if (!ACTIONS.includes(action)) return res.status(400).json({ ok: false, error: "bad_action" });
  if (action === "reply_kind" && !(String(req.body?.kind ?? "") in REPLY_KIND_LABEL)) return res.status(400).json({ ok: false, error: "bad_kind" });
  const own = await pool.query(`SELECT 1 FROM crm_engagement WHERE contact_id = $1 AND silo = $2`, [id, silo(req)]);
  if (!own.rowCount && action !== "booked") return res.status(404).json({ ok: false, error: "not_tracked", message: "This contact is not in the outreach." });
  const start = req.body?.start ? new Date(String(req.body.start)) : null;
  const ok = await recordEvent(pool, {
    contactId: id, kind: action, actor: actor(req),
    detail: { kind: s(req.body?.kind, 40), reason: s(req.body?.reason, 200), start: start && !Number.isNaN(start.getTime()) ? start.toISOString() : null, note: s(req.body?.note, 500) },
  });
  if (!ok) return res.status(404).json({ ok: false, error: "not_tracked" });
  res.json({ ok: true, contact: await contactDetail(pool, silo(req), id) });
}));
router.post("/contacts/:id/owner", wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  const r = await pool.query(`UPDATE crm_engagement SET owner_user_id = $3, owner_name = $4, updated_at = now() WHERE contact_id = $1 AND silo = $2`,
    [id, silo(req), s(req.body?.user_id, 80), s(req.body?.name, 120)]);
  if (!r.rowCount) return res.status(404).json({ ok: false, error: "not_tracked" });
  res.json({ ok: true });
}));
router.get("/settings", wrap(async (req, res) => res.json({ ok: true, settings: await getSettings(pool, silo(req)) })));
router.put("/settings", wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "admin_only" });
  const followers = Array.isArray(req.body?.followers)
    ? req.body.followers.map((f: any) => ({ id: s(f?.id, 80), name: s(f?.name, 120) ?? "" })).filter((f: any) => f.id).slice(0, 20)
    : undefined;
  await saveSettings(pool, silo(req), { followers, digest: typeof req.body?.digest === "boolean" ? req.body.digest : undefined });
  res.json({ ok: true, settings: await getSettings(pool, silo(req)) });
}));

export default router;
