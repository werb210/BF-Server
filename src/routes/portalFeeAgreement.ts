// BF_SERVER_MEDIA_FEE_AGREEMENT_v709 - staff view of an application's client fee
// agreement (media files sent to a lender that does not pay Boreal).
// GET /api/portal/applications/:id/fee-agreement
import { Router } from "express";
import { dbQuery } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getFeeAgreement, sendMediaFeeAgreementNow } from "../services/feeAgreement/mediaFeeAgreement.js";

const router = Router();

// BF_SERVER_FEE_MANUAL_SIGN_v775 - a fee agreement negotiated and signed outside the portal.
export type ManualFeeInput = { note: string; feePercent: number | null; feeAmount: number | null; signedAt: Date; signerName: string | null };
export function parseManualFeeInput(body: any, now = new Date()): { ok: true; value: ManualFeeInput } | { ok: false; message: string } {
  const note = String(body?.note ?? "").trim().slice(0, 500);
  if (!note) return { ok: false, message: "Add a short note about what was agreed." };
  const num = (v: unknown): number | null => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v));
  const feePercent = num(body?.feePercent), feeAmount = num(body?.feeAmount);
  if (feePercent !== null && !(Number.isFinite(feePercent) && feePercent >= 0 && feePercent <= 100)) return { ok: false, message: "The fee percent must be between 0 and 100." };
  if (feeAmount !== null && !(Number.isFinite(feeAmount) && feeAmount >= 0)) return { ok: false, message: "The fee amount must be a positive number." };
  let signedAt = now;
  const day = String(body?.signedOn ?? "").trim();
  if (day) {
    const d = new Date(day + "T12:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(d.getTime())) return { ok: false, message: "The signed date is not a real date." };
    if (d.getTime() > now.getTime() + 36 * 60 * 60 * 1000) return { ok: false, message: "The signed date cannot be in the future." };
    signedAt = d;
  }
  const signerName = String(body?.signerName ?? "").trim().slice(0, 120) || null;
  return { ok: true, value: { note, feePercent, feeAmount, signedAt, signerName } };
}

type ManualFields = { signed_manually: boolean; manual_note: string | null; fee_percent: string | null; fee_amount: string | null; manual_by_name: string | null };
async function manualFields(applicationId: string): Promise<ManualFields | null> {
  try {
    const r = await dbQuery<ManualFields>(
      "SELECT m.signed_manually, m.manual_note, m.fee_percent::text AS fee_percent, m.fee_amount::text AS fee_amount, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.email) AS manual_by_name FROM media_fee_agreements m LEFT JOIN users u ON u.id::text = m.manual_signed_by WHERE m.application_id = $1 LIMIT 1",
      [applicationId],
    );
    return r.rows[0] ?? null;
  } catch (err: any) {
    console.warn("[fee-agreement] manual_fields_read_failed", { applicationId, message: String(err?.message ?? err) });
    return null;
  }
}

// BF_SERVER_FEE_DIAGNOSE_v745 - Twilio accepting a text is not the same as the phone receiving it. sms_deliveries
// holds the carrier's answer (delivered / undelivered + error code) from the status callback; show it to staff.
async function recentFeeTexts(applicationId: string): Promise<Array<{ toLast4: string; status: string | null; errorCode: string | null; createdAt: string }>> {
  try {
    const r = await dbQuery<{ to_number: string | null; status: string | null; error_code: string | null; created_at: string }>("SELECT to_number, status, error_code, created_at FROM sms_deliveries WHERE application_id = $1 AND kind = 'media_fee_agreement' ORDER BY created_at DESC LIMIT 6", [applicationId]);
    return r.rows.map((x) => ({ toLast4: String(x.to_number ?? "").replace(/[^0-9]/g, "").slice(-4), status: x.status, errorCode: x.error_code, createdAt: x.created_at }));
  } catch (err: any) {
    console.warn("[fee-agreement] texts_read_failed", { applicationId, message: String(err?.message ?? err) });
    return [];
  }
}

export async function diagnoseFeeAgreement(applicationId: string): Promise<Record<string, unknown>> {
  const app = (await dbQuery<{ metadata: unknown; product_category: string | null }>("SELECT metadata, product_category FROM applications WHERE id::text = ($1)::text LIMIT 1", [applicationId])).rows[0];
  if (!app) return { ok: false, problems: ["application not found"] };
  const { pickFeeSigner } = await import("../services/feeAgreement/mediaFeeAgreement.js");
  const { isApiKeyConfigured } = await import("../signnow/signnowClient.js");
  const signer = pickFeeSigner(app.metadata);
  const digits = String(signer.phone ?? "").replace(/[^0-9]/g, "");
  const from = process.env.TWILIO_PHONE || process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_CALLER_ID || process.env.TWILIO_FROM || process.env.TWILIO_NUMBER || process.env.TWILIO_PHONE_NUMBER || "";
  const problems: string[] = [];
  if (digits.length < 10) problems.push("no usable mobile number for the signer on this application");
  if (!signer.email) problems.push("no email for the signer on this application");
  if (!from) problems.push("no Twilio sending number set on the server (TWILIO_PHONE)");
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) problems.push("Twilio account credentials missing on the server");
  if (String(process.env.TEST_MODE ?? "").toLowerCase() === "true") problems.push("server is in TEST_MODE - texts are skipped");
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM) problems.push("email (SendGrid) not configured on the server");
  if (!isApiKeyConfigured()) problems.push("e-signature (SignNow) not configured on the server");
  const texts = await recentFeeTexts(applicationId);
  for (const t of texts) if (t.status && /undelivered|failed/i.test(t.status)) problems.push("text to mobile ending " + t.toLast4 + " was " + t.status + (t.errorCode ? " (Twilio error " + t.errorCode + ")" : ""));
  return { ok: problems.length === 0, problems, signer: { name: signer.name, isApplicant: signer.isApplicant, mobileLast4: digits.slice(-4) || null, email: signer.email }, sendingNumberLast4: from.replace(/[^0-9]/g, "").slice(-4) || null, texts };
}

// BF_SERVER_FEE_NOTICE_DELIVERY_v740 - the last few notices for this agreement, so staff see what
// actually went out (text, email, app) and why anything failed.
async function recentFeeNotices(applicationId: string): Promise<Array<{ channel: string; error: string | null; createdAt: string }>> {
  try {
    const r = await dbQuery<{ channel: string; error: string | null; created_at: string }>("SELECT channel, error, created_at FROM client_notifications WHERE application_id = $1 AND kind = 'media_fee_agreement' ORDER BY created_at DESC LIMIT 6", [applicationId]);
    return r.rows.map((x) => ({ channel: x.channel, error: x.error, createdAt: x.created_at }));
  } catch (err: any) {
    console.warn("[fee-agreement] notices_read_failed", { applicationId, message: String(err?.message ?? err) });
    return [];
  }
}

router.get(
  "/applications/:id/fee-agreement",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) { res.status(400).json({ error: "application_id_required" }); return; }
    const ag = await getFeeAgreement(id);
    if (!ag) { res.status(200).json({ required: false }); return; }
    res.status(200).json({
      required: true,
      status: ag.status,
      signerName: ag.signer_name,
      signerEmail: ag.signer_email,
      signerIsApplicant: ag.signer_is_applicant,
      lenderName: ag.trigger_lender_name,
      createdAt: ag.created_at,
      sentAt: ag.sent_at,
      signedAt: ag.signed_at,
      documentId: ag.document_id,
      notices: await recentFeeNotices(id),
      texts: await recentFeeTexts(id), // BF_SERVER_FEE_DIAGNOSE_v745
      ...(await (async () => { const m = await manualFields(id); return m ? { signedManually: Boolean(m.signed_manually), manualNote: m.manual_note, manualSignedByName: m.manual_by_name, feePercent: m.fee_percent === null ? null : Number(m.fee_percent), feeAmount: m.fee_amount === null ? null : Number(m.fee_amount) } : {}; })()), // BF_SERVER_FEE_MANUAL_SIGN_v775
    });
  })
);

// BF_SERVER_FEE_DIAGNOSE_v745 - one click tells staff exactly why a fee agreement would not reach the client.
router.get(
  "/applications/:id/fee-agreement/diagnose",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) { res.status(400).json({ error: "application_id_required" }); return; }
    res.json(await diagnoseFeeAgreement(id));
  })
);

// BF_SERVER_FEE_AGREEMENT_SEND_NOW_v731 - "Send fee agreement to client" on a Media file.
// POST /api/portal/applications/:id/fee-agreement/send   { lenderName?: string }
router.post(
  "/applications/:id/fee-agreement/send",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) { res.status(400).json({ error: "application_id_required" }); return; }
    const lenderName = typeof req.body?.lenderName === "string" && req.body.lenderName.trim() ? req.body.lenderName.trim().slice(0, 120) : null;
    try {
      const out = await sendMediaFeeAgreementNow(id, lenderName);
      if (!out.ok) {
        const msg = out.reason === "not_media" ? "Only Media files get the client fee agreement." : out.reason === "already_signed" ? "The client has already signed the fee agreement." : "Application not found.";
        res.status(out.reason === "application_not_found" ? 404 : 409).json({ error: out.reason, message: msg });
        return;
      }
      res.status(200).json({ ok: true, result: out.reason, delivery: out.delivery ?? null }); // BF_SERVER_FEE_NOTICE_DELIVERY_v740
    } catch (err: any) {
      res.status(502).json({ error: "send_failed", message: "Could not send the agreement: " + String(err?.message ?? err).slice(0, 200) });
    }
  })
);

// BF_SERVER_FEE_MANUAL_SIGN_v775 - mark the client fee agreement signed outside the portal.
// POST /api/portal/applications/:id/fee-agreement/mark-signed  { note, feePercent?, feeAmount?, signedOn?, signerName? }
// Creates the agreement row if the file never had one. The client's "Sign your fee agreement" to-do then shows as done.
router.post(
  "/applications/:id/fee-agreement/mark-signed",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) { res.status(400).json({ error: "application_id_required" }); return; }
    const parsed = parseManualFeeInput(req.body);
    if (!parsed.ok) { res.status(400).json({ error: "invalid_input", message: parsed.message }); return; }
    const app = (await dbQuery<{ metadata: unknown }>("SELECT metadata FROM applications WHERE id::text = ($1)::text LIMIT 1", [id])).rows[0];
    if (!app) { res.status(404).json({ error: "application_not_found", message: "Application not found." }); return; }
    const { pickFeeSigner } = await import("../services/feeAgreement/mediaFeeAgreement.js");
    const v = parsed.value;
    const signer = v.signerName ?? pickFeeSigner(app.metadata).name ?? null;
    const userId = String(req.user?.id ?? req.user?.userId ?? "") || null;
    await dbQuery(
      "INSERT INTO media_fee_agreements (application_id, signer_name, status, signed_at, signed_manually, manual_signed_by, manual_note, fee_percent, fee_amount, updated_at) VALUES ($1, $2, 'signed', $3, true, $4, $5, $6, $7, now()) ON CONFLICT (application_id) DO UPDATE SET status = 'signed', signed_at = EXCLUDED.signed_at, signed_manually = true, manual_signed_by = EXCLUDED.manual_signed_by, manual_note = EXCLUDED.manual_note, fee_percent = EXCLUDED.fee_percent, fee_amount = EXCLUDED.fee_amount, signer_name = COALESCE(EXCLUDED.signer_name, media_fee_agreements.signer_name), updated_at = now()",
      [id, signer, v.signedAt.toISOString(), userId, v.note, v.feePercent, v.feeAmount],
    );
    console.info({ event: "fee_agreement_marked_signed", applicationId: id, userId, feePercent: v.feePercent, feeAmount: v.feeAmount });
    res.status(200).json({ ok: true });
  })
);

// BF_SERVER_FEE_MANUAL_SIGN_v775 - undo a manual mark (a mistake). Agreements signed through SignNow cannot be undone here.
router.post(
  "/applications/:id/fee-agreement/unmark-signed",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) { res.status(400).json({ error: "application_id_required" }); return; }
    const r = await dbQuery<{ id: string }>(
      "UPDATE media_fee_agreements SET status = 'pending', signed_at = NULL, signed_manually = false, manual_signed_by = NULL, manual_note = NULL, fee_percent = NULL, fee_amount = NULL, updated_at = now() WHERE application_id = $1 AND signed_manually = true RETURNING id::text AS id",
      [id],
    );
    if (!r.rows[0]) { res.status(409).json({ error: "not_manual", message: "Only an agreement marked signed by staff can be undone here." }); return; }
    console.info({ event: "fee_agreement_manual_mark_undone", applicationId: id, userId: req.user?.id ?? req.user?.userId ?? null });
    res.status(200).json({ ok: true });
  })
);

export default router;
