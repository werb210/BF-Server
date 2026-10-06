// BF_SERVER_WEEKLY_SUMMARY_v721 - Monday-morning business summary to Todd and Andrew
// (same recipients and SendGrid sender as the Monday ads email, sent alongside it):
// last week's submissions and funded deals, the open pipeline, stuck files, missed
// calls nobody returned, and splits or agreements waiting on someone.
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";
import { sendgridConfigured, sendTransactional } from "./sendgridService.js";
import { commissionRate } from "./googleDataManager.js";
import { weeklyRecipients, mondayWindow } from "./adsWeeklyEmail.js";
import { stuckDeals } from "./reports/data.js";
import { missedCalls } from "./reports/data2.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" }[c] as string));
const money = (n: unknown) => "$" + Math.round(Number(n ?? 0)).toLocaleString("en-CA");

export type SummaryData = {
  submitted: number; funded: number; fundedAmount: number;
  pipeline: Array<{ stage: string; files: number }>;
  stuck: Array<{ name: string; stage: string | null; days_in_stage: number }>;
  missedNotReturned: number; splitsWaiting: number; feeAgreementsWaiting: number;
};

export async function gatherSummary(): Promise<SummaryData> {
  const week = await pool.query<{ submitted: number; funded: number; funded_amount: number }>(
    `SELECT count(*) FILTER (WHERE submitted_at >= now() - interval '7 days')::int AS submitted,
            count(*) FILTER (WHERE funded_at >= now() - interval '7 days')::int AS funded,
            COALESCE(sum(COALESCE(funded_amount, requested_amount)) FILTER (WHERE funded_at >= now() - interval '7 days'),0)::float AS funded_amount
       FROM applications WHERE silo = 'BF'`,
  );
  const pipe = await pool.query<{ stage: string; files: number }>(
    `SELECT pipeline_state AS stage, count(*)::int AS files FROM applications
      WHERE silo = 'BF' AND submitted_at IS NOT NULL AND funded_at IS NULL
        AND lower(COALESCE(pipeline_state,'')) <> ALL(ARRAY['funded','declined','rejected','closed','withdrawn','archived','lost','accepted','draft'])
      GROUP BY 1 ORDER BY 2 DESC`,
  );
  const waiting = await pool.query<{ splits: number; fees: number }>(
    `SELECT (SELECT count(*) FROM broker_deal_confirmations WHERE status <> 'accepted')::int AS splits,
            (SELECT count(*) FROM media_fee_agreements WHERE status <> 'signed')::int AS fees`,
  );
  const stuck = await stuckDeals(7);
  const missed = await missedCalls({ days: 7 });
  const w = week.rows[0] ?? { submitted: 0, funded: 0, funded_amount: 0 };
  return {
    submitted: w.submitted, funded: w.funded, fundedAmount: w.funded_amount,
    pipeline: pipe.rows,
    stuck: stuck.items.filter((i: any) => i.days_in_stage >= 7).slice(0, 8).map((i: any) => ({ name: String(i.name), stage: i.stage ?? null, days_in_stage: i.days_in_stage })),
    missedNotReturned: missed.not_called_back,
    splitsWaiting: waiting.rows[0]?.splits ?? 0, feeAgreementsWaiting: waiting.rows[0]?.fees ?? 0,
  };
}

export function renderSummary(d: SummaryData, rate: number): { subject: string; html: string } {
  const row = (a: string, b: string) => `<tr><td style="padding:4px 12px 4px 0;color:#475569">${esc(a)}</td><td style="padding:4px 0;font-weight:600">${esc(b)}</td></tr>`;
  const html = [
    `<div style="font-family:Arial,sans-serif;color:#0f172a;max-width:640px">`,
    `<h2 style="margin:0 0 4px">Boreal Financial - week in review</h2>`,
    `<p style="margin:0 0 16px;color:#475569">The last 7 days.</p>`,
    `<table>`,
    row("Applications submitted", String(d.submitted)),
    row("Deals funded", `${d.funded} (${money(d.fundedAmount)}, about ${money(d.fundedAmount * rate)} commission)`),
    row("Missed calls nobody returned", String(d.missedNotReturned)),
    row("Broker splits not yet agreed", String(d.splitsWaiting)),
    row("Media fee agreements not signed", String(d.feeAgreementsWaiting)),
    `</table>`,
    `<h3 style="margin:18px 0 6px">Open pipeline</h3>`,
    d.pipeline.length ? `<table>${d.pipeline.map((p) => row(p.stage, String(p.files))).join("")}</table>` : `<p>No open files.</p>`,
    `<h3 style="margin:18px 0 6px">Stuck 7+ days in their stage</h3>`,
    d.stuck.length ? `<table>${d.stuck.map((s) => row(s.name, `${s.stage ?? "-"}, ${s.days_in_stage} days`)).join("")}</table>` : `<p>None.</p>`,
    `<p style="margin-top:18px;color:#64748b;font-size:12px">Full detail: staff portal, Reports.</p>`,
    `</div>`,
  ].join("");
  return { subject: `Boreal week in review: ${d.submitted} submitted, ${d.funded} funded`, html };
}

/** Sends this week's summary if it is Monday morning and it has not gone yet. */
export async function maybeSendWeeklySummary(now = new Date(), force = false): Promise<{ sent: boolean; reason?: string }> {
  const week = force ? now.toISOString().slice(0, 10) : mondayWindow(now);
  if (!week) return { sent: false, reason: "not_monday_morning" };
  if (!sendgridConfigured()) return { sent: false, reason: "email_not_configured" };
  const claim = await pool.query("INSERT INTO weekly_summary_reports (week_start, recipients) VALUES ($1, $2) ON CONFLICT (week_start) DO NOTHING RETURNING week_start", [week, weeklyRecipients().join(",")]);
  if (claim.rowCount === 0) return { sent: false, reason: "already_sent" };
  const { subject, html } = renderSummary(await gatherSummary(), commissionRate());
  let ok = 0;
  for (const to of weeklyRecipients()) {
    const r = await sendTransactional({ to, subject, html }) /* BF_SERVER_TRANSACTIONAL_BYPASS_UNSUB_v761 - a staff report, not marketing */;
    if (r.ok) ok += 1; else logError("weekly_summary_email_failed", { to, status: r.status, error: r.error });
  }
  if (ok === 0) await pool.query("DELETE FROM weekly_summary_reports WHERE week_start = $1", [week]);
  return { sent: ok > 0 };
}
