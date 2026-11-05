// BF_SERVER_v890_MAYA_LENDER_UPDATES - lender-profile changes Maya proposed from Teams meetings, for staff to approve.
//   GET   /api/lender-updates/lenders/:lenderId           open proposals for one lender
//   PATCH /api/lender-updates/:meetingId/:updateId        { decision: "approve" | "reject" }
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { pool } from "../db.js";
import { actorId, UUID_RE } from "../brokerTools/common.js";
import { decideProfileUpdate, listLenderProposals, UpdateError } from "../services/teams/lenderProfileUpdates.js";

const router = Router();
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];

router.get("/lenders/:lenderId", ...staff, safeHandler(async (req: any, res: any) => {
  const lenderId = String(req.params.lenderId ?? "").trim();
  if (!UUID_RE.test(lenderId)) return res.status(400).json({ error: "bad_lender_id" });
  const meetings = await listLenderProposals(pool as any, lenderId, resolveSiloFromRequest(req));
  res.json({ meetings });
}));

router.patch("/:meetingId/:updateId", ...staff, safeHandler(async (req: any, res: any) => {
  const meetingId = String(req.params.meetingId ?? "").trim();
  const updateId = String(req.params.updateId ?? "").trim();
  const decision = req.body?.decision === "approve" ? "approve" : req.body?.decision === "reject" ? "reject" : null;
  if (!UUID_RE.test(meetingId) || !/^u\d{1,2}$/.test(updateId)) return res.status(400).json({ error: "bad_id" });
  if (!decision) return res.status(400).json({ error: "decision must be approve or reject" });
  try {
    const update = await decideProfileUpdate(pool as any, {
      meetingId, updateId, decision, userId: actorId(req), silo: resolveSiloFromRequest(req),
    });
    res.json({ update });
  } catch (err) {
    if (err instanceof UpdateError) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }
}));

export default router;
