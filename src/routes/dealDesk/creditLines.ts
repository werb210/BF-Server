// BF_SERVER_v867_BROKER_TOOLS_CREDIT_LINES - /api/deal-desk: approved credit lines per client (credit_lines, Growth and Pro).
//   GET    /applications/:id/credit-lines         the client's lines (same company or contact) and the line this deal draws on
//   POST   /applications/:id/credit-lines         record a line { lender_id | lender_name, product_name, limit_amount, approved_on, expiry_date, conditions, reminder_days }
//   PUT    /applications/:id/credit-line          { credit_line_id | null }: this deal draws on that line when it funds
//   GET    /credit-lines?status=&expiring_within=  every line in the silo
//   PATCH  /credit-lines/:lid                     edit, or { status: active | closed }
//   POST   /credit-lines/:lid/draws               { amount, kind: draw | repayment, drawn_on, note, application_id } (Admin: allow_over_limit)
//   DELETE /credit-lines/:lid/draws/:did          reverse a draw
import { Router, type NextFunction, type Request, type Response } from "express";
import { safeHandler } from "../../middleware/safeHandler.js";
import { getSilo } from "../../middleware/silo.js";
import { actorId, audit, db, isAdmin, str, UUID_RE } from "../../brokerTools/common.js";
import { gate } from "../../brokerTools/platform.js";
import { appGuard, bad, staff } from "../../brokerTools/http.js";
import {
  DrawError, addDraw, createLine, getLine, linesForApplication, listLines, parseLineInput, reverseDraw, updateLine,
} from "../../brokerTools/creditLines.js";

const router = Router();
const cl = [...staff, gate("credit_lines")];

/** Loads the line into res.locals.line; 404 when missing or in another silo. */
function lineGuard(req: Request, res: Response, next: NextFunction): void {
  (async () => {
    const id = String(req.params.lid ?? "");
    const line = UUID_RE.test(id) ? await getLine(db(), id) : null;
    const silo = getSilo(res);
    if (!line || (silo && line.silo !== silo)) return bad(res, "Credit line not found.", 404, "not_found");
    res.locals.line = line;
    next();
  })().catch(next);
}

router.get("/applications/:id/credit-lines", ...cl, appGuard, safeHandler(async (_req: Request, res: Response) => {
  const app = res.locals.app;
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, lines: await linesForApplication(db(), app), linked_line_id: app.metadata?.credit_line_id ?? null });
}));

router.post("/applications/:id/credit-lines", ...cl, appGuard, safeHandler(async (req: Request, res: Response) => {
  const p = parseLineInput((req.body ?? {}) as Record<string, unknown>);
  if (!p.ok) return bad(res, p.error);
  const line = await createLine(db(), res.locals.app, p.value, actorId(req));
  await audit(req, "credit_line.added", { application_id: req.params.id, lender: line.lender_name, limit: line.limit_amount, expiry: line.expiry_date }, { type: "credit_line", id: line.id });
  res.status(201).json({ ok: true, line });
}));

router.put("/applications/:id/credit-line", ...cl, appGuard, safeHandler(async (req: Request, res: Response) => {
  const lineId = str((req.body ?? {}).credit_line_id, 80);
  if (lineId) {
    const lines = await linesForApplication(db(), res.locals.app);
    if (!lines.some((l) => l.id === lineId && l.status === "active")) return bad(res, "Pick one of this client's active lines.");
  }
  await db().query(
    `UPDATE applications SET metadata = CASE WHEN $2::text IS NULL THEN COALESCE(metadata, '{}'::jsonb) - 'credit_line_id'
       ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('credit_line_id', $2::text) END, updated_at = now() WHERE id::text = $1`,
    [String(req.params.id), lineId],
  );
  await audit(req, "credit_line.linked", { application_id: req.params.id, credit_line_id: lineId }, { type: "application", id: String(req.params.id) });
  res.json({ ok: true, linked_line_id: lineId });
}));

router.get("/credit-lines", ...cl, safeHandler(async (req: Request, res: Response) => {
  const within = req.query.expiring_within === undefined ? null : Math.max(0, Math.min(3650, Math.floor(Number(req.query.expiring_within)) || 0));
  const status = ["active", "expired", "closed"].includes(String(req.query.status)) ? String(req.query.status) : null;
  const lines = await listLines(db(), getSilo(res) ?? "BF", { expiringWithin: within, status });
  const names = await db().query(
    `SELECT c.id::text AS id, c.name FROM companies c WHERE c.id::text = ANY($1::text[])`,
    [lines.map((l) => l.company_id).filter(Boolean)],
  );
  const byId = new Map(names.rows.map((r: any) => [r.id, r.name]));
  res.json({ ok: true, lines: lines.map((l) => ({ ...l, company_name: l.company_id ? byId.get(l.company_id) ?? null : null })) });
}));

router.patch("/credit-lines/:lid", ...cl, lineGuard, safeHandler(async (req: Request, res: Response) => {
  const p = parseLineInput((req.body ?? {}) as Record<string, unknown>, true);
  if (!p.ok) return bad(res, p.error);
  const line = await updateLine(db(), String(req.params.lid), p.value);
  await audit(req, "credit_line.updated", { changes: p.value }, { type: "credit_line", id: String(req.params.lid) });
  res.json({ ok: true, line });
}));

router.post("/credit-lines/:lid/draws", ...cl, lineGuard, safeHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  try {
    const line = await addDraw(db(), res.locals.line, b, actorId(req), { allowOverLimit: isAdmin(req) && b.allow_over_limit === true });
    await audit(req, "credit_line.draw", { kind: b.kind ?? "draw", amount: b.amount, available: line.available }, { type: "credit_line", id: line.id });
    res.status(201).json({ ok: true, line });
  } catch (err) {
    if (err instanceof DrawError) return bad(res, err.message, 409, "draw_refused");
    throw err;
  }
}));

router.delete("/credit-lines/:lid/draws/:did", ...cl, lineGuard, safeHandler(async (req: Request, res: Response) => {
  const did = String(req.params.did);
  if (!UUID_RE.test(did) || !(await reverseDraw(db(), String(req.params.lid), did, actorId(req)))) return bad(res, "Draw not found.", 404, "not_found");
  await audit(req, "credit_line.draw_reversed", { draw_id: did }, { type: "credit_line", id: String(req.params.lid) });
  res.json({ ok: true, line: await getLine(db(), String(req.params.lid)) });
}));

export default router;
