// BF_SERVER_v872_QUOTES - quotes, the client's side (client app; the caller's OTP phone must be on the application).
// Ported from KS-server #50 without the plan gate.
//   GET  /api/client/quotes/applications/:id   sent quotes on the file (never drafts)
//   GET  /api/client/quotes/:qid               one quote; counts as a view
//   GET  /api/client/quotes/:qid/pdf           the branded PDF
//   POST /api/client/quotes/:qid/accept        { option_id, name, agree: true }
//   POST /api/client/quotes/:qid/decline       { reason? }
import { Router } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { callerOwnsApplication } from "../auth/clientApplicationOwnership.js";
import { clientIpFromRequest } from "../middleware/clientIp.js";
import { acceptQuote, clientQuote, declineQuote, listQuotes, loadQuote, quotePdf, recordView, type Db } from "../quotes/service.js";

const router = Router();
const db = () => pool as unknown as Db;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGES: Record<string, string> = {
  quote_expired: "This quote has expired. Your advisor can send you a new one.",
  quote_not_open: "This quote can no longer be answered.",
  pick_an_option: "Please choose one of the options.",
  type_your_full_name: "Please type your full name.",
  tick_to_agree: "Please tick the box to confirm.",
};

const applicationHint = (req: any) => String(req.query?.applicationId ?? req.body?.applicationId ?? "");

async function ownQuote(req: any, res: any) {
  const q = await loadQuote(db(), String(req.params.qid ?? ""));
  if (!q || q.status === "draft") {
    // Fail closed: an unknown quote id is refused like someone else's (403) unless the caller owns the file it names.
    if (!(await callerOwnsApplication(req, q ? String(q.application_id) : applicationHint(req)))) { res.status(403).json({ ok: false, error: "forbidden" }); return null; }
    res.status(404).json({ ok: false, error: "not_found" }); return null;
  }
  if (!(await callerOwnsApplication(req, q.application_id))) { res.status(403).json({ ok: false, error: "forbidden" }); return null; }
  return q;
}

router.get("/applications/:id", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  if (!(await callerOwnsApplication(req, id))) return res.status(403).json({ ok: false, error: "forbidden" });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, quotes: (await listQuotes(db(), id, { includeDrafts: false })).map(clientQuote) });
}));

router.get("/:qid", safeHandler(async (req: any, res: any) => {
  const q = await ownQuote(req, res);
  if (!q) return;
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, quote: clientQuote(await recordView(q, db())) });
}));

router.get("/:qid/pdf", safeHandler(async (req: any, res: any) => {
  const q = await ownQuote(req, res);
  if (!q) return;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Quote-${q.quote_number}.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(Buffer.from(await quotePdf(q, db())));
}));

router.post("/:qid/accept", safeHandler(async (req: any, res: any) => {
  const q = await ownQuote(req, res);
  if (!q) return;
  const r = await acceptQuote(q, {
    optionId: String(req.body?.option_id ?? ""), name: String(req.body?.name ?? ""), agree: req.body?.agree === true,
    ip: clientIpFromRequest(req) || null, userAgent: String(req.headers?.["user-agent"] ?? "") || null,
  }, db());
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error, message: MESSAGES[r.error] ?? r.error });
  return res.json({ ok: true, quote: clientQuote(r.quote) });
}));

router.post("/:qid/decline", safeHandler(async (req: any, res: any) => {
  const q = await ownQuote(req, res);
  if (!q) return;
  const r = await declineQuote(q, String(req.body?.reason ?? ""), db());
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error, message: MESSAGES[r.error] ?? r.error });
  return res.json({ ok: true, quote: clientQuote(r.quote) });
}));

export default router;
