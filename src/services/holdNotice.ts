// BF_SERVER_HOLD_CLIENT_EMAIL_v108
// When staff put an application on Hold, the client is told why. Sent from
// submissions@ (MS_GRAPH_SEND_AS) so replies land in the shared mailbox the
// pipeline already watches, rather than an individual's inbox.
import { dbQuery } from "../db.js";
import { sendViaGraph } from "./email/graphSendService.js";
import { logInfo, logError } from "../observability/logger.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Best effort by design: a failure to email must never leave the application in
 * a state that disagrees with what staff just did on screen. The hold is already
 * committed by the time this runs; a bounce is logged, not thrown.
 */
export async function sendHoldNoticeToClient(
  applicationId: string,
  reason: string,
): Promise<{ sent: boolean; error?: string }> {
  const trimmed = String(reason ?? "").trim();
  if (!trimmed) {
    logInfo("hold_notice_skipped_no_reason", { applicationId });
    return { sent: false, error: "no_reason" };
  }

  const r = await dbQuery<{ email: string | null; first_name: string | null; name: string | null }>(
    `SELECT c.email, c.first_name, c.name
       FROM applications a
       LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.id::text = ($1)::text
      LIMIT 1`,
    [applicationId],
  ).catch(() => ({ rows: [] as Array<{ email: string | null; first_name: string | null; name: string | null }> }));

  const row = r.rows[0];
  const to = String(row?.email ?? "").trim();
  if (!to) {
    logInfo("hold_notice_skipped_no_email", { applicationId });
    return { sent: false, error: "no_client_email" };
  }

  const firstName =
    String(row?.first_name ?? "").trim() ||
    String(row?.name ?? "").trim().split(/\s+/)[0] ||
    "there";

  // Multi-line reasons become a list; a single line stays a single paragraph.
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const reasonHtml = lines.length > 1
    ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(lines[0])}</p>`;
  const reasonText = lines.length > 1 ? lines.map((l) => `  - ${l}`).join("\n") : lines[0];

  const bodyHtml =
    `<p>${escapeHtml(firstName)},</p>` +
    `<p>Your application has been archived and is no longer being worked on for the following reason(s):</p>` +
    reasonHtml +
    `<p>Your application and documents will be held for 30 days. If you do not address the reasons above within that time, all will be purged as per our privacy policy.</p>` +
    `<p>Thank you,<br/>Boreal Financial</p>`;

  const bodyText =
    `${firstName},\n\n` +
    `Your application has been archived and is no longer being worked on for the following reason(s):\n\n` +
    `${reasonText}\n\n` +
    `Your application and documents will be held for 30 days. If you do not address the reasons above within that time, all will be purged as per our privacy policy.\n\n` +
    `Thank you,\nBoreal Financial`;

  const sent = await sendViaGraph({
    to,
    subject: "Your Boreal Financial application has been placed on hold",
    bodyHtml,
    bodyText,
  });

  if (!sent.ok) {
    logError("hold_notice_send_failed", { applicationId, error: String(sent.error).slice(0, 400) });
    return { sent: false, error: String(sent.error) };
  }
  logInfo("hold_notice_sent", { applicationId, to });
  return { sent: true };
}
