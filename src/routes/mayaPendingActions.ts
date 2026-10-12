// BF_SERVER_v784_MAYA_SMS_CONFIRM
// Maya proposes outbound SMS (POST /api/maya/staff/send-sms) but never sends it.
// The proposal waits in maya_pending_actions until the staff member it belongs
// to confirms it here. Human staff tokens only: the agent's service token can
// create proposals but can never confirm its own (403).
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { logError } from "../observability/logger.js";
import { principalFromRequest } from "../auth/principal.js";
import { staffIdFromPrincipal } from "../services/mayaContext.js";
import { sendSms } from "../modules/notifications/sms.service.js";
import { audit } from "./mayaStaff.js";

const router = Router();

type Caller = { id: string; isAdmin: boolean };

function staffCaller(req: Request, res: Response): Caller | null {
  const p = principalFromRequest(req as any);
  if (!p) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return null;
  }
  const id = staffIdFromPrincipal(p);
  if (p.kind !== "staff" || !id) {
    res.status(403).json({ ok: false, error: "staff_only" });
    return null;
  }
  return { id, isAdmin: String(p.claims.role ?? "").toLowerCase() === "admin" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get(
  "/pending-actions",
  safeHandler(async (req: Request, res: Response) => {
    const caller = staffCaller(req, res);
    if (!caller) return;
    const r = await pool.query(
      `SELECT id, kind, payload, status, created_at, expires_at
         FROM maya_pending_actions
        WHERE staff_user_id = $1 AND status = 'pending' AND expires_at > now()
          AND kind = 'sms' -- BF_SERVER_v789_MAYA_MKT_CONFIRM: marketing previews are confirmed through Maya, not here
        ORDER BY created_at DESC
        LIMIT 100`,
      [caller.id],
    );
    return res.json({ ok: true, items: r.rows });
  }),
);

router.post(
  "/pending-actions/:id/confirm",
  safeHandler(async (req: Request, res: Response) => {
    const caller = staffCaller(req, res);
    if (!caller) return;
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) return res.status(404).json({ ok: false, error: "not_found" });

    // Atomic claim: only one confirm can move a row out of 'pending', so an SMS
    // goes out at most once even when two confirms race.
    const claimed = await pool.query<{ id: string; kind: string; payload: any; staff_user_id: string | null }>(
      `UPDATE maya_pending_actions
          SET status = 'sending', decided_at = now()
        WHERE id = $1 AND status = 'pending' AND expires_at > now()
          AND (staff_user_id = $2 OR $3::boolean)
        RETURNING id, kind, payload, staff_user_id`,
      [id, caller.id, caller.isAdmin],
    );
    const row = claimed.rows[0];
    if (!row) {
      const cur = await pool.query<{ status: string; staff_user_id: string | null; expired: boolean }>(
        `SELECT status, staff_user_id, (expires_at <= now()) AS expired FROM maya_pending_actions WHERE id = $1`,
        [id],
      );
      const c = cur.rows[0];
      if (!c) return res.status(404).json({ ok: false, error: "not_found" });
      if (c.staff_user_id !== caller.id && !caller.isAdmin) return res.status(403).json({ ok: false, error: "not_yours" });
      if (c.status === "pending" && c.expired) return res.status(410).json({ ok: false, error: "expired", status: "expired" });
      return res.status(409).json({ ok: false, error: "not_pending", status: c.status });
    }

    if (row.kind !== "sms") {
      await pool.query(
        `UPDATE maya_pending_actions SET status = 'failed', result = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify({ error: "unsupported_kind" })],
      );
      return res.status(400).json({ ok: false, status: "failed", error: "unsupported_kind" });
    }

    const to = String(row.payload?.to ?? "");
    const body = String(row.payload?.body ?? "");
    try {
      const sent: any = await sendSms({ to, message: body });
      const sid = sent?.sid ?? null;
      await pool.query(
        `UPDATE maya_pending_actions SET status = 'sent', result = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify({ sid })],
      );
      await audit({ audience: "staff", tool: "comm.send_sms", args: { to, contact_id: row.payload?.contactId ?? null, pending_id: id, confirmed_by: caller.id }, ok: true, summary: `sent sms to ${to}`, userId: caller.id });
      return res.json({ ok: true, status: "sent", sid });
    } catch (e: any) {
      const error = e?.message ?? "send_failed";
      logError("maya_pending_sms_send_failed", { code: "maya_pending_sms_send_failed", error });
      await pool.query(
        `UPDATE maya_pending_actions SET status = 'failed', result = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify({ error: String(error).slice(0, 500) })],
      );
      await audit({ audience: "staff", tool: "comm.send_sms", args: { to, pending_id: id, confirmed_by: caller.id }, ok: false, summary: String(error), errorCode: "send_sms_exception", userId: caller.id });
      return res.status(502).json({ ok: false, status: "failed", error: "send_failed" });
    }
  }),
);

router.post(
  "/pending-actions/:id/cancel",
  safeHandler(async (req: Request, res: Response) => {
    const caller = staffCaller(req, res);
    if (!caller) return;
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
    const r = await pool.query(
      `UPDATE maya_pending_actions
          SET status = 'cancelled', decided_at = now()
        WHERE id = $1 AND status = 'pending' AND (staff_user_id = $2 OR $3::boolean)
        RETURNING id`,
      [id, caller.id, caller.isAdmin],
    );
    if (!r.rows[0]) {
      const cur = await pool.query<{ status: string; staff_user_id: string | null }>(
        `SELECT status, staff_user_id FROM maya_pending_actions WHERE id = $1`,
        [id],
      );
      const c = cur.rows[0];
      if (!c) return res.status(404).json({ ok: false, error: "not_found" });
      if (c.staff_user_id !== caller.id && !caller.isAdmin) return res.status(403).json({ ok: false, error: "not_yours" });
      return res.status(409).json({ ok: false, error: "not_pending", status: c.status });
    }
    return res.json({ ok: true, status: "cancelled" });
  }),
);

export default router;
