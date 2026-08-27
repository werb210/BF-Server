// BF_SERVER_REJECTION_REASONS_v124
import { dbQuery } from "../db.js";
import { sendViaGraph } from "./email/graphSendService.js";
import { logInfo, logError } from "../observability/logger.js";

function esc(v: string): string {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

type ReasonRow = { code: string; label: string; why_it_matters: string; what_helps: string | null };

export async function collectRejectionReasons(applicationId: string): Promise<ReasonRow[]> {
  const r = await dbQuery<ReasonRow>(
    `SELECT DISTINCT rr.code, rr.label, rr.why_it_matters, rr.what_helps, rr.sort_order
       FROM application_rejection_reasons arr JOIN rejection_reasons rr ON rr.code = arr.reason_code
      WHERE arr.application_id::text = ($1)::text ORDER BY rr.sort_order ASC`, [applicationId],
  ).catch(() => ({ rows: [] as ReasonRow[] }));
  return r.rows;
}

export async function sendRejectionNoticeToClient(applicationId: string, note?: string): Promise<{ sent: boolean; error?: string }> {
  const guard = await dbQuery<{ already: string | null }>(
    `UPDATE applications SET rejection_email_sent_at = NOW()
      WHERE id::text = ($1)::text AND rejection_email_sent_at IS NULL RETURNING id::text AS already`, [applicationId],
  ).catch(() => ({ rows: [] as Array<{ already: string | null }> }));
  if (guard.rows.length === 0) {
    logInfo("rejection_notice_already_sent", { applicationId });
    return { sent: false, error: "already_sent" };
  }

  const c = await dbQuery<{ email: string | null; first_name: string | null; business_name: string | null }>(
    `SELECT co.email, co.first_name, a.business_name FROM applications a
       LEFT JOIN contacts co ON co.id = a.contact_id WHERE a.id::text = ($1)::text LIMIT 1`, [applicationId],
  ).catch(() => ({ rows: [] as Array<{ email: string | null; first_name: string | null; business_name: string | null }> }));
  const to = String(c.rows[0]?.email ?? "").trim();
  if (!to) return { sent: false, error: "no_client_email" };
  const reasons = await collectRejectionReasons(applicationId);
  if (reasons.length === 0) return { sent: false, error: "no_reasons" };

  const first = String(c.rows[0]?.first_name ?? "").trim();
  const biz = String(c.rows[0]?.business_name ?? "").trim();
  const count = reasons.length === 1 ? "One thing stood" : `${reasons.length} things stood`;
  const items = reasons.map((r, i) => {
    const helps = r.what_helps
      ? `<p style="margin:6px 0 0"><em>What helps:</em> ${esc(r.what_helps)}</p>`
      : "";
    return `<div style="margin:0 0 18px"><p style="margin:0"><strong>${i + 1}. ${esc(r.label)}</strong></p><p style="margin:4px 0 0">${esc(r.why_it_matters)}</p>${helps}</div>`;
  }).join("");
  const extra = String(note ?? "").trim() ? `<p style="margin:0 0 18px">${esc(String(note).trim())}</p>` : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#0B1F3A">
    <p>${first ? `Hi ${esc(first)},` : "Hi,"}</p>
    <p>Thanks for the time you put into your application${biz ? ` for ${esc(biz)}` : ""}. We have reviewed it with our lending partners, and we are not able to move forward right now.</p>
    <p>We would rather tell you exactly why than leave you guessing. ${count} in the way:</p>${items}${extra}
    <p>None of this is permanent. When any of the above has changed, reply to this email or call us and we will take another look - you will not need to start over.</p>
    <p style="margin-top:20px">Boreal Financial Corp.<br/>+1 (825) 451-1768</p></div>`;
  const text = [first ? `Hi ${first},` : "Hi,", "", `Thanks for the time you put into your application${biz ? ` for ${biz}` : ""}. We have reviewed it with our lending partners, and we are not able to move forward right now.`, "", `We would rather tell you exactly why than leave you guessing. ${count} in the way:`, "", ...reasons.flatMap((r, i) => [`${i + 1}. ${r.label}`, r.why_it_matters, ...(r.what_helps ? [`What helps: ${r.what_helps}`] : []), ""]), ...(String(note ?? "").trim() ? [String(note).trim(), ""] : []), "None of this is permanent. When any of the above has changed, reply to this email or call us and we will take another look - you will not need to start over.", "", "Boreal Financial Corp.", "+1 (825) 451-1768"].join("\n");

  try {
    await sendViaGraph({ to, subject: "Your Boreal Financial application - decision and next steps", bodyText: text, bodyHtml: html });
    logInfo("rejection_notice_sent", { applicationId, reasons: reasons.length });
    return { sent: true };
  } catch (err) {
    await dbQuery(`UPDATE applications SET rejection_email_sent_at = NULL WHERE id::text = ($1)::text`, [applicationId]).catch(() => {});
    logError("rejection_notice_failed", { applicationId, error: String(err) });
    return { sent: false, error: String(err) };
  }
}

export async function allSentLendersPassed(applicationId: string): Promise<boolean> {
  const r = await dbQuery<{ sent: string; passed: string }>(
    `SELECT (SELECT count(DISTINCT lender_id)::text FROM application_packages WHERE application_id::text = ($1)::text AND sent_at IS NOT NULL) AS sent,
       (SELECT count(DISTINCT lender_id)::text FROM application_lender_responses WHERE application_id::text = ($1)::text AND outcome = 'declined') AS passed`, [applicationId],
  ).catch(() => ({ rows: [] as Array<{ sent: string; passed: string }> }));
  const sent = Number(r.rows[0]?.sent ?? 0);
  const passed = Number(r.rows[0]?.passed ?? 0);
  return sent > 0 && passed >= sent;
}
