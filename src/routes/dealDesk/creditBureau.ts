// BF_SERVER_v867_BROKER_TOOLS_CREDIT_BUREAU - /api/deal-desk: credit bureau pulls (credit_bureau, Growth and Pro).
//   GET  /credit-bureau/providers                                 which bureaus are ready, test mode, what is missing to set up
//   GET  /applications/:id/credit-bureau                          consents, pulls, the applicant's details for a new request
//   POST /applications/:id/credit-bureau/consents                 ask for consent { first_name, last_name, email, date_of_birth?, street, city, province, postal_code }
//   POST /applications/:id/credit-bureau/consents/:cid/attest     Admin: consent given on a signed form { note }
//   POST /applications/:id/credit-bureau/consents/:cid/revoke
//   POST /applications/:id/credit-bureau/pulls                    { consent_id, bureau: equifax_ca | transunion_ca }
//   GET  /applications/:id/credit-bureau/pulls/:pid/report        the report PDF
import { Router, type Request, type Response } from "express";
import { safeHandler } from "../../middleware/safeHandler.js";
import { actorId, audit, db, isAdmin, str, UUID_RE } from "../../brokerTools/common.js";
import { gate } from "../../brokerTools/platform.js";
import { appGuard, bad, staff } from "../../brokerTools/http.js";
import { fileOnApplication } from "../../brokerTools/contracts.js";
import {
  BUREAUS, BureauError, applicantFrom, attestConsent, listConsents, listPulls, parseSubject, providerStatus, pullCredit, requestConsent, type Bureau,
} from "../../brokerTools/creditBureau.js";

const router = Router();
const cb = [...staff, gate("credit_bureau")];

router.get("/credit-bureau/providers", ...cb, (_req: Request, res: Response) => { res.json({ ok: true, providers: providerStatus() }); });

async function applicant(app: Record<string, any>) {
  const contact = app.contact_id ? (await db().query(`SELECT name, email FROM contacts WHERE id::text = $1 LIMIT 1`, [String(app.contact_id)])).rows[0] ?? null : null;
  return applicantFrom(app, contact);
}

router.get("/applications/:id/credit-bureau", ...cb, appGuard, safeHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, consents: await listConsents(db(), id), pulls: await listPulls(db(), id), applicant: await applicant(res.locals.app), providers: providerStatus(), bureaus: BUREAUS });
}));

router.post("/applications/:id/credit-bureau/consents", ...cb, appGuard, safeHandler(async (req: Request, res: Response) => {
  const s = parseSubject((req.body ?? {}) as Record<string, unknown>, await applicant(res.locals.app));
  if (typeof s === "string") return bad(res, s);
  const c = await requestConsent(db(), String(req.params.id), s, actorId(req));
  await audit(req, "credit_consent.requested", { application_id: req.params.id, person: `${s.first_name} ${s.last_name}` }, { type: "application", id: String(req.params.id) });
  res.status(201).json({ ok: true, consent: c });
}));

router.post("/applications/:id/credit-bureau/consents/:cid/attest", ...cb, appGuard, safeHandler(async (req: Request, res: Response) => {
  if (!isAdmin(req)) return bad(res, "Only an Admin can record consent from a signed form.", 403, "forbidden");
  const cid = String(req.params.cid);
  const note = str((req.body ?? {}).note, 1000);
  if (!UUID_RE.test(cid)) return bad(res, "Consent not found.", 404, "not_found");
  if (!note || note.length < 10) return bad(res, "Say where the signed consent is kept (at least 10 characters).");
  const c = await attestConsent(db(), String(req.params.id), cid, note, actorId(req));
  if (!c) return bad(res, "This consent request is not open.", 409, "not_open");
  await audit(req, "credit_consent.attested", { application_id: req.params.id, consent_id: cid, note }, { type: "application", id: String(req.params.id) });
  res.json({ ok: true, consent: c });
}));

router.post("/applications/:id/credit-bureau/consents/:cid/revoke", ...cb, appGuard, safeHandler(async (req: Request, res: Response) => {
  const cid = String(req.params.cid);
  if (!UUID_RE.test(cid)) return bad(res, "Consent not found.", 404, "not_found");
  const r = await db().query(`UPDATE credit_consents SET status = 'revoked', updated_at = now() WHERE application_id = $1 AND id = $2::uuid AND status <> 'revoked' RETURNING id`, [String(req.params.id), cid]);
  if (!r.rows[0]) return bad(res, "Consent not found.", 404, "not_found");
  await audit(req, "credit_consent.revoked", { application_id: req.params.id, consent_id: cid }, { type: "application", id: String(req.params.id) });
  res.json({ ok: true });
}));

router.post("/applications/:id/credit-bureau/pulls", ...cb, appGuard, safeHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const bureau = String(b.bureau ?? "") as Bureau;
  const cid = String(b.consent_id ?? "");
  if (!(bureau in BUREAUS)) return bad(res, "Pick Equifax or TransUnion.");
  if (!UUID_RE.test(cid)) return bad(res, "Pick whose consent to use.");
  try {
    const pull = await pullCredit(db(), String(req.params.id), cid, bureau, actorId(req), fileOnApplication);
    await audit(req, "credit_pull.completed", { application_id: req.params.id, bureau, provider: pull.provider, status: pull.status, score: pull.score }, { type: "application", id: String(req.params.id) });
    res.status(201).json({ ok: true, pull });
  } catch (err) {
    if (err instanceof BureauError) {
      await audit(req, "credit_pull.refused", { application_id: req.params.id, bureau, reason: err.code }, { type: "application", id: String(req.params.id) });
      return bad(res, err.message, err.code === "failed" ? 502 : 409, err.code);
    }
    throw err;
  }
}));

router.get("/applications/:id/credit-bureau/pulls/:pid/report", ...cb, appGuard, safeHandler(async (req: Request, res: Response) => {
  const pid = String(req.params.pid);
  const r = UUID_RE.test(pid) ? await db().query(`SELECT bureau, report_pdf FROM credit_pulls WHERE application_id = $1 AND id = $2::uuid`, [String(req.params.id), pid]) : { rows: [] as any[] };
  if (!r.rows[0]?.report_pdf) return bad(res, "Report not found.", 404, "not_found");
  await audit(req, "credit_report.viewed", { application_id: req.params.id, pull_id: pid }, { type: "application", id: String(req.params.id) });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${BUREAUS[r.rows[0].bureau as Bureau] ?? "Credit"} report.pdf"`);
  res.send(r.rows[0].report_pdf);
}));

export default router;
