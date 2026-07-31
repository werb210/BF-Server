// BF_SERVER_ACCOUNTANT_INVITE_v1 - the invitation an accountant receives when an
// applicant names their firm at Step 5. Copy approved by Todd; the only
// conditional part is the support-phone line.
import { pool } from "../db.js";
import { sendgridConfigured, sendTransactional } from "./sendgridService.js";

const BOREAL_ADDRESS = "450 Sparling Crt SW, Edmonton, AB T6X 1G9";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildAccountantInvite(vars: {
  accountantName: string;
  accountantPhone: string;
  applicantName: string;
  businessName: string;
  portalLink: string;
  supportPhone?: string | null;
}): { subject: string; html: string } {
  const subject = `Document request for ${vars.businessName} — sent at your client's request`;
  const support = String(vars.supportPhone ?? "").trim();
  const contactLine = support
    ? `If you have questions, reply to this email or call us at ${esc(support)}.`
    : "If you have questions, just reply to this email.";

  const html = [
    `<p>Hello ${esc(vars.accountantName)},</p>`,
    `<p>${esc(vars.applicantName)} at ${esc(vars.businessName)} has applied for business financing through Boreal Financial and asked us to contact you directly for the financial documents supporting the application.</p>`,
    `<p>Before we proceed, please confirm with ${esc(vars.applicantName)} that you are authorised to release these documents to us. You can forward this email to them for that confirmation.</p>`,
    `<p>Once confirmed, you can upload everything through our secure client portal. Sign in with this phone number &mdash; ${esc(vars.accountantPhone)} &mdash; and we'll text you a one-time code. No password to set up.</p>`,
    `<p><a href="${esc(vars.portalLink)}">${esc(vars.portalLink)}</a></p>`,
    "<p>You'll see only the documents we need from you, nothing else on the file.</p>",
    `<p>${contactLine}</p>`,
    `<p>Thank you,<br/>Boreal Financial<br/>${esc(BOREAL_ADDRESS)}</p>`,
  ].join("\n");

  return { subject, html };
}

// Best-effort. Returns the outcome for logging; callers must not await-and-throw.
export async function sendAccountantInvite(opts: {
  applicationId: string;
  contactId: string;
  accountantName: string;
  accountantEmail: string;
  accountantPhone: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const claim = await pool.query(
    `INSERT INTO accountant_invites (application_id, contact_id, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (application_id, contact_id) DO NOTHING
     RETURNING id`,
    [opts.applicationId, opts.contactId, opts.accountantEmail]
  );
  if (claim.rowCount === 0) return { sent: false, reason: "already_invited" };

  if (!sendgridConfigured()) {
    await pool.query(
      "UPDATE accountant_invites SET error = $2 WHERE application_id = $1 AND contact_id = $3",
      [opts.applicationId, "sendgrid_not_configured", opts.contactId]
    );
    return { sent: false, reason: "sendgrid_not_configured" };
  }

  const appRes = await pool
    .query<{ business_name: string | null; first_name: string | null; last_name: string | null }>(
      `SELECT a.name AS business_name, c.first_name, c.last_name
         FROM applications a
         LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.id::text = ($1)::text
        LIMIT 1`,
      [opts.applicationId]
    )
    .catch(() => ({ rows: [] as any[] }));
  const row: any = appRes.rows[0] ?? {};
  const businessName = String(row.business_name ?? "").trim() || "your client";
  const applicantName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || "your client";

  const portalBase = (process.env.CLIENT_PORTAL_URL || "https://client.boreal.financial").replace(/\/+$/, "");
  const { subject, html } = buildAccountantInvite({
    accountantName: opts.accountantName || "there",
    accountantPhone: opts.accountantPhone,
    applicantName,
    businessName,
    portalLink: `${portalBase}/accountant`,
    supportPhone: process.env.BOREAL_SUPPORT_PHONE ?? null,
  });

  const result = await sendTransactional({
    to: opts.accountantEmail,
    subject,
    html,
    contactId: opts.contactId,
    customArgs: { message_kind: "accountant_invite", application_id: opts.applicationId },
  });

  if (result.ok) {
    await pool.query(
      `UPDATE accountant_invites SET sent_at = NOW(), error = NULL
        WHERE application_id = $1 AND contact_id = $2`,
      [opts.applicationId, opts.contactId]
    );
    return { sent: true };
  }

  await pool.query(
    "DELETE FROM accountant_invites WHERE application_id = $1 AND contact_id = $2 AND sent_at IS NULL",
    [opts.applicationId, opts.contactId]
  );
  return { sent: false, reason: result.error || `sendgrid_${result.status}` };
}
