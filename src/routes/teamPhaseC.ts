// BF_SERVER_TEAM_PHASE_C_v671 - REST for Team chat Phase C, mounted inside team.ts:
// GET /api/team/cards, GET /api/team/saved, POST|DELETE /api/team/messages/:id/save.
import { Router } from "express";
import { ROLES } from "../auth/roles.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { listSaved, loadCards, parseCardIds, saveMessage, unsaveMessage } from "../services/team/teamPhaseC.js";

const router = Router();
const guard = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] })];

function userIdOf(req: any): string {
  const id = req.user?.id ?? req.user?.userId ?? req.user?.sub ?? null;
  if (!id) throw new AppError("unauthorized", "Authentication required.", 401);
  return String(id);
}

router.get("/cards", ...guard, safeHandler(async (req: any, res: any) => {
  userIdOf(req);
  res.status(200).json({ ok: true, cards: await loadCards(parseCardIds(req.query?.ids)) });
}));

router.get("/saved", ...guard, safeHandler(async (req: any, res: any) => {
  res.status(200).json({ ok: true, saved: await listSaved(userIdOf(req)) });
}));

router.post("/messages/:id/save", ...guard, safeHandler(async (req: any, res: any) => {
  const raw = req.body?.remind_at;
  let remindAt: string | null = null;
  if (raw != null && raw !== "") {
    const when = new Date(String(raw));
    if (Number.isNaN(when.getTime())) throw new AppError("validation_error", "remind_at must be a date and time.", 400);
    remindAt = when.toISOString();
  }
  const saved = await saveMessage(userIdOf(req), String(req.params.id), remindAt);
  if (!saved) throw new AppError("not_found", "Message not found.", 404);
  res.status(200).json({ ok: true, saved });
}));

router.delete("/messages/:id/save", ...guard, safeHandler(async (req: any, res: any) => {
  res.status(200).json({ ok: true, removed: await unsaveMessage(userIdOf(req), String(req.params.id)) });
}));

export default router;
