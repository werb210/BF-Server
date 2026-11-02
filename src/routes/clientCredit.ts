// BF_SERVER_v867_BROKER_TOOLS_CREDIT_BUREAU - /api/client-credit: the client app's side of credit bureau consent. Every route checks
// that the signed-in client owns the application (403 otherwise).
//   GET  /consents?applicationId=        consent requests for the application (the wording, whose consent; never the date of birth)
//   POST /consents/:id                   { applicationId, full_name, date_of_birth, agree: true } - give consent
import { Router, type Request, type Response } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { callerOwnsApplication } from "../auth/clientApplicationOwnership.js";
import { db } from "../brokerTools/common.js";
import { giveConsent, listConsents } from "../brokerTools/creditBureau.js";
import { featureOn } from "../brokerTools/platform.js";

const router = Router();
const APP_ID = /^[0-9a-f-]{36}$/i;

async function owned(req: Request, res: Response, applicationId: string): Promise<boolean> {
  if (!APP_ID.test(applicationId)) { res.status(400).json({ ok: false, error: "invalid_application_id" }); return false; }
  if (!(await callerOwnsApplication(req, applicationId))) { res.status(403).json({ ok: false, error: "forbidden" }); return false; }
  return true;
}

const view = (c: Record<string, any>) => ({
  id: c.id, status: c.status, person: `${c.subject?.first_name ?? ""} ${c.subject?.last_name ?? ""}`.trim(), consent_text: c.consent_text,
  given_at: c.given_at ? new Date(c.given_at).toISOString() : null, needs_date_of_birth: !c.subject?.date_of_birth,
});

router.get("/consents", safeHandler(async (req: Request, res: Response) => {
  const applicationId = String(req.query.applicationId ?? "").trim();
  if (!(await owned(req, res, applicationId))) return;
  res.setHeader("Cache-Control", "no-store");
  if (!(await featureOn("credit_bureau"))) return void res.json({ ok: true, consents: [] });
  res.json({ ok: true, consents: (await listConsents(db(), applicationId)).filter((c: any) => c.status !== "revoked").map(view) });
}));

router.post("/consents/:id", safeHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const applicationId = String(b.applicationId ?? "").trim();
  if (!(await owned(req, res, applicationId))) return;
  if (!APP_ID.test(String(req.params.id))) return void res.status(404).json({ ok: false, error: "not_found" });
  const out = await giveConsent(db(), applicationId, String(req.params.id), b, { ip: typeof req.ip === "string" ? req.ip : null, ua: String(req.headers["user-agent"] ?? "") || null });
  if (typeof out === "string") return void res.status(400).json({ ok: false, error: "invalid", message: out });
  res.json({ ok: true, consent: view(out) });
}));

export default router;
