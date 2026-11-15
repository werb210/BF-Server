// BF_SERVER_v960_LENDER_REPS - who at the lender is handling a submitted file. Mounted at /api/portal.
//   GET  /applications/:id/lender-reps                 the file's lenders, each with its reps and the one chosen
//   PUT  /applications/:id/lenders/:lenderId/rep       { rep_id } or { rep_id: null } to go back to the lender's general address
//   GET  /lenders/:lenderId/reps                       the reps on record for a lender
//   POST /lenders/:lenderId/reps                       { name, position?, email, phone?, application_id? } adds (or
//                                                      updates) a rep; with application_id it is also set on that file
import { Router, type Response, type NextFunction } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { fileLenderReps, listReps, parseRep, saveRep, setRepForFile } from "../services/lenders/lenderReps.js";

const router: Router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function staffOnly(req: AuthRequest, res: Response, next: NextFunction): void {
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role === ROLES.ADMIN || role === ROLES.STAFF) return next();
  res.status(403).json({ error: "Forbidden" });
}
const who = (req: AuthRequest): string | null => {
  const u = (req.user ?? {}) as { userId?: string; id?: string; sub?: string };
  return String(u.userId ?? u.id ?? u.sub ?? "") || null;
};

router.get("/applications/:id/lender-reps", requireAuth, staffOnly, safeHandler(async (req: AuthRequest, res: Response) => {
  res.json({ ok: true, lenders: await fileLenderReps(String(req.params.id)) });
}));

router.put("/applications/:id/lenders/:lenderId/rep", requireAuth, staffOnly, safeHandler(async (req: AuthRequest, res: Response) => {
  const lenderId = String(req.params.lenderId);
  const repId = req.body?.rep_id ? String(req.body.rep_id) : null;
  if (!UUID_RE.test(lenderId) || (repId && !UUID_RE.test(repId))) return res.status(400).json({ ok: false, error: "invalid_id", message: "Choose a rep from the list." });
  const r = await setRepForFile(String(req.params.id), lenderId, repId, who(req));
  if (r !== "ok") return res.status(404).json({ ok: false, error: r, message: "That rep is not on record for this lender." });
  return res.json({ ok: true, lenders: await fileLenderReps(String(req.params.id)) });
}));

router.get("/lenders/:lenderId/reps", requireAuth, staffOnly, safeHandler(async (req: AuthRequest, res: Response) => {
  const lenderId = String(req.params.lenderId);
  if (!UUID_RE.test(lenderId)) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true, reps: await listReps(lenderId) });
}));

router.post("/lenders/:lenderId/reps", requireAuth, staffOnly, safeHandler(async (req: AuthRequest, res: Response) => {
  const lenderId = String(req.params.lenderId);
  if (!UUID_RE.test(lenderId)) return res.status(404).json({ ok: false, error: "not_found" });
  const parsed = parseRep(req.body ?? {});
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "invalid_rep", errors: parsed.errors });
  const rep = await saveRep(lenderId, parsed.value, who(req));
  const applicationId = req.body?.application_id ? String(req.body.application_id) : "";
  if (applicationId) await setRepForFile(applicationId, lenderId, rep.id, who(req));
  return res.status(201).json({ ok: true, rep, ...(applicationId ? { lenders: await fileLenderReps(applicationId) } : {}) });
}));

export default router;
