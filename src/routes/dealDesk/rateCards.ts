// BF_SERVER_v867_BROKER_TOOLS_RATE_CARDS - /api/deal-desk: lender rate cards and the structuring tool (rate_cards, Growth and Pro).
//   GET    /rate-cards                       every card with its grid (staff)
//   POST   /rate-cards | PUT /rate-cards/:cid | DELETE /rate-cards/:cid     Admin
//   POST   /rate-cards/:cid/import           Admin: { csv } or multipart "file" (term,min,max,tier,rate) replaces the grid
//   GET    /rate-cards/:cid/export           the grid as CSV
//   POST   /structure                        { amount, province, terms, tier, residual_pct, down_payment, tax_mode, advance } -> options
//   GET    /applications/:id/structure       the deal's defaults (cost, province, tier) and the last saved structure
//   POST   /applications/:id/structure       compute for the deal; { save: true, chosen: <option index> } keeps it on the file
import { Router, type Request, type Response } from "express";
import { safeHandler } from "../../middleware/safeHandler.js";
import { actorId, audit, db, num, UUID_RE } from "../../brokerTools/common.js";
import { gate } from "../../brokerTools/platform.js";
import { admin, appGuard, bad, staff, upload } from "../../brokerTools/http.js";
import { applicationProvince } from "../../brokerTools/salesTax.js";
import {
  TAX_MODES, TIERS, cellsToCsv, getCard, listCards, parseCardInput, parseRateCsv, parseStructureInput, replaceCells, saveCard, structure, type StructureInput,
} from "../../brokerTools/rateCards.js";

const router = Router();
const rc = [...staff, gate("rate_cards")];
const rcAdmin = [...admin, gate("rate_cards")];

router.get("/rate-cards", ...rc, safeHandler(async (_req: Request, res: Response) => {
  res.json({ ok: true, cards: await listCards(db()), tax_modes: TAX_MODES, tiers: TIERS });
}));

router.post("/rate-cards", ...rcAdmin, safeHandler(async (req: Request, res: Response) => {
  const p = parseCardInput((req.body ?? {}) as Record<string, unknown>);
  if (!p.ok) return bad(res, p.error);
  const id = await saveCard(db(), null, p.value, actorId(req));
  await audit(req, "rate_card.created", { name: p.value.name }, { type: "rate_card", id });
  res.status(201).json({ ok: true, card: await getCard(db(), id) });
}));

router.put("/rate-cards/:cid", ...rcAdmin, safeHandler(async (req: Request, res: Response) => {
  const cid = String(req.params.cid);
  if (!UUID_RE.test(cid) || !(await getCard(db(), cid))) return bad(res, "Rate card not found.", 404, "not_found");
  const p = parseCardInput((req.body ?? {}) as Record<string, unknown>);
  if (!p.ok) return bad(res, p.error);
  await saveCard(db(), cid, p.value, actorId(req));
  await audit(req, "rate_card.updated", { name: p.value.name, active: p.value.active }, { type: "rate_card", id: cid });
  res.json({ ok: true, card: await getCard(db(), cid) });
}));

router.delete("/rate-cards/:cid", ...rcAdmin, safeHandler(async (req: Request, res: Response) => {
  const cid = String(req.params.cid);
  if (!UUID_RE.test(cid)) return bad(res, "Rate card not found.", 404, "not_found");
  const r = await db().query(`DELETE FROM rate_cards WHERE id = $1::uuid RETURNING name`, [cid]);
  if (!r.rows[0]) return bad(res, "Rate card not found.", 404, "not_found");
  await audit(req, "rate_card.deleted", { name: r.rows[0].name }, { type: "rate_card", id: cid });
  res.json({ ok: true });
}));

router.post("/rate-cards/:cid/import", ...rcAdmin, upload.single("file"), safeHandler(async (req: Request, res: Response) => {
  const cid = String(req.params.cid);
  if (!UUID_RE.test(cid) || !(await getCard(db(), cid))) return bad(res, "Rate card not found.", 404, "not_found");
  const text = req.file ? req.file.buffer.toString("utf8") : String((req.body ?? {}).csv ?? "");
  const p = parseRateCsv(text);
  if (!p.ok) return bad(res, p.error);
  const n = await replaceCells(db(), cid, p.cells);
  await audit(req, "rate_card.imported", { rows: n }, { type: "rate_card", id: cid });
  res.json({ ok: true, imported: n, card: await getCard(db(), cid) });
}));

router.get("/rate-cards/:cid/export", ...rc, safeHandler(async (req: Request, res: Response) => {
  const cid = String(req.params.cid);
  const card = UUID_RE.test(cid) ? await getCard(db(), cid) : null;
  if (!card) return bad(res, "Rate card not found.", 404, "not_found");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${card.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim() || "rate-card"}.csv"`);
  res.send(cellsToCsv(card.cells));
}));

router.post("/structure", ...rc, safeHandler(async (req: Request, res: Response) => {
  const p = parseStructureInput((req.body ?? {}) as Record<string, unknown>);
  if (!p.ok) return bad(res, p.error);
  res.json({ ok: true, input: p.value, ...(await structure(db(), p.value)) });
}));

/** What the deal starts from: the equipment cost (or the amount asked for), the business's province, the scorecard grade. */
async function dealDefaults(app: Record<string, any>): Promise<Partial<StructureInput>> {
  const md = app.metadata ?? {};
  const amount = num(md.equipment_amount) || num(app.requested_amount) || undefined;
  const province = await applicationProvince(db(), String(app.id));
  // BF_SERVER_v867_BROKER_TOOLS_SCORECARDS - the scorecard grade is the starting credit tier.
  const g = await db().query(`SELECT grade FROM application_scorecards WHERE application_id = $1 LIMIT 1`, [String(app.id)]);
  const tier: string | null = g.rows[0]?.grade ?? null;
  return { amount: amount ?? undefined, province, tier, terms: [24, 36, 48, 60], tax_mode: "lease" };
}

router.get("/applications/:id/structure", ...rc, appGuard, safeHandler(async (req: Request, res: Response) => {
  const saved = await db().query(
    `SELECT id::text AS id, inputs, options, chosen, note, created_at FROM deal_structures WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [String(req.params.id)],
  );
  res.json({ ok: true, defaults: await dealDefaults(res.locals.app), saved: saved.rows[0] ?? null });
}));

router.post("/applications/:id/structure", ...rc, appGuard, safeHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const p = parseStructureInput(b, await dealDefaults(res.locals.app));
  if (!p.ok) return bad(res, p.error);
  const out = await structure(db(), p.value);
  let saved: string | null = null;
  if (b.save === true) {
    const idx = Math.floor(Number(b.chosen));
    const chosen = Number.isInteger(idx) && idx >= 0 && idx < out.options.length ? out.options[idx] : null;
    const r = await db().query(
      `INSERT INTO deal_structures (application_id, inputs, options, chosen, note, created_by) VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6::uuid) RETURNING id::text AS id`,
      [String(req.params.id), JSON.stringify(p.value), JSON.stringify(out.options), chosen ? JSON.stringify(chosen) : null, typeof b.note === "string" ? b.note.slice(0, 2000) : null, actorId(req)],
    );
    saved = r.rows[0].id;
    await audit(req, "deal_structure.saved", { application_id: req.params.id, options: out.options.length, chosen: chosen ? `${chosen.lender_name} ${chosen.term_months}m` : null }, { type: "application", id: String(req.params.id) });
  }
  res.json({ ok: true, input: p.value, ...out, saved_id: saved });
}));

export default router;
