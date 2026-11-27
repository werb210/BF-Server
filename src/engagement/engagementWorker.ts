// BF_SERVER_ENGAGEMENT_v1 - every five minutes: bring the outreach stages up to date, give follow-ups an owner and make
// tasks for new replies and bookings. Once each weekday morning (7am Alberta time): one email per follow-up owner with
// what is waiting for them in PGI (from BI-Server) and Keystone, and on Mondays last week's leaks.
import type { Pool } from "pg";
import { claimedTick } from "../workers/claim.js";
import { sendViaGraph } from "../services/email/graphSendService.js";
import { createFollowUpTasks, digestFor, funnel, getSettings, owners as localOwners, syncEngagement } from "./engagement.js";
import { getBi } from "./notify.js";
import { ALBERTA_TZ } from "../lib/albertaTime.js";

export async function runEngagementTick(db: Pick<Pool, "query">): Promise<Record<string, number>> {
  const sync = await syncEngagement(db);
  const tasks = await createFollowUpTasks(db, async (owner, silo, title, notes, contactId) => {
    const r = await db.query(
      `INSERT INTO tasks (silo, title, body, type, priority, due_at, assignee_user_id, contact_id, source)
       VALUES ($1, $2, $3, 'TODO', 'HIGH', now() + interval '1 day', $4::uuid, $5::uuid, 'WORKFLOW') RETURNING id`,
      [silo, title.slice(0, 250), notes, owner, contactId],
    ).catch((err: unknown) => { console.warn("[engagement] task failed", { message: (err as Error)?.message }); return null; });
    return { ok: Boolean(r?.rowCount) };
  });
  return { ...sync, tasks };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const REASON: Record<string, string> = { replied: "replied", booked: "booked", clicked: "clicked", no_show: "missed the meeting" };

function section(title: string, d: any, link: string): string {
  if (!d || !Number(d.open)) return `<h3 style="margin:16px 0 4px">${esc(title)}</h3><p style="margin:0;color:#555">Nothing waiting.</p>`;
  const top = (d.top ?? []).map((t: any) => `<li>${esc([t.full_name, t.organization_name].filter(Boolean).join(", ") || "A contact")} - ${esc(REASON[t.follow_up_reason] ?? t.follow_up_reason)}${t.reply_kind ? ` (${esc(t.reply_kind.replace(/_/g, " "))})` : ""}${new Date(t.follow_up_due_at) < new Date() ? ' <b style="color:#b91c1c">overdue</b>' : ""}</li>`).join("");
  return `<h3 style="margin:16px 0 4px">${esc(title)}</h3>
    <p style="margin:0 0 6px">${d.replies} ${d.replies === 1 ? "reply" : "replies"}, ${d.bookings} booked, ${d.clickers} clicked - ${d.overdue} overdue.${d.meetings_today ? ` ${d.meetings_today} meeting(s) today.` : ""}</p>
    <ul style="margin:0 0 6px 18px;padding:0">${top}</ul><p style="margin:0"><a href="${link}">Open the follow-up queue</a></p>`;
}

export async function sendDigests(db: Pick<Pool, "query">, now = new Date()): Promise<number> {
  const biOwners = ((await getBi("/engagement/owners"))?.owners ?? []) as Array<{ id: string; name: string }>;
  const ids = new Set<string>([...biOwners.map((o) => o.id), ...(await localOwners(db)).map((o) => o.id)]);
  const monday = new Intl.DateTimeFormat("en-CA", { timeZone: ALBERTA_TZ, weekday: "short" }).format(now) === "Mon";
  let sent = 0;
  for (const id of ids) {
    const u = (await db.query(`SELECT coalesce(o365_user_email, email) AS email, first_name FROM users WHERE id::text = $1 AND coalesce(active, true)`, [id])).rows[0];
    if (!u?.email) continue;
    const biRes = await getBi(`/engagement/digest?owner=${encodeURIComponent(id)}`);
    const pgi = biRes && biRes.enabled !== false ? biRes.digest ?? null : null;
    const local = await digestFor(db, id);
    const ks = (await getSettings(db, "KS")).digest ? local.bySilo.find((r: any) => r.silo === "KS") ?? null : null;
    if (ks) ks.top = local.top.filter((t: any) => t.silo === "KS");
    if (!Number(pgi?.open) && !Number(ks?.open)) continue;
    let weekly = "";
    if (monday) {
      const line = (name: string, k: any) => k ? `<p style="margin:0 0 4px"><b>${name}:</b> ${k.clickers_not_called} clicked and were never followed up, ${k.meetings_no_outcome} meeting(s) with no outcome recorded${k.avg_reply_hours != null ? `, replies answered in ${k.avg_reply_hours} hours on average` : ""}.</p>` : "";
      const ksLeaks = (await funnel(db, "KS", new Date(now.getTime() - 7 * 86_400_000))).leaks;
      const pgiLeaks = (await getBi("/engagement/leaks?days=7"))?.leaks ?? null;
      weekly = `<h3 style="margin:16px 0 4px">Last week</h3>${line("PGI", pgiLeaks)}${line("Keystone", ksLeaks)}`;
    }
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
      <p>Good morning${u.first_name ? ` ${esc(u.first_name)}` : ""}. Here is who is waiting to hear from you.</p>
      ${section("PGI (Boreal Risk Management)", pgi, "https://staff.boreal.financial/silo/bi/marketing?tab=outreach")}
      ${section("Keystone", ks, "https://staff.boreal.financial/silo/ks/marketing/outreach")}
      ${weekly}</div>`;
    const total = Number(pgi?.open ?? 0) + Number(ks?.open ?? 0);
    const r = await sendViaGraph({ to: u.email, subject: `${total} ${total === 1 ? "person is" : "people are"} waiting for a follow-up`, bodyHtml: html, bodyText: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
    if (r.ok) sent += 1; else console.warn("[engagement] digest send failed", { error: String(r.error).slice(0, 200) });
  }
  return sent;
}

/** 7am Alberta time, Monday to Friday, once a day. */
export function digestDue(now: Date, lastSentDay: string | null): { due: boolean; day: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: ALBERTA_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hour12: false })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  const weekday = !["Sat", "Sun"].includes(String(parts.weekday));
  return { due: weekday && hour >= 7 && hour < 11 && lastSentDay !== day, day };
}

export function startEngagementWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("engagement", async () => {
    const r = await runEngagementTick(pool);
    if (Object.values(r).some((n) => n > 0)) console.info("[engagement] tick", r);
    const last = (await pool.query(`SELECT value->>'day' AS day FROM crm_engagement_settings WHERE silo = '*' AND key = 'digest_sent'`)).rows[0]?.day ?? null;
    const { due, day } = digestDue(new Date(), last);
    if (!due) return;
    await pool.query(
      `INSERT INTO crm_engagement_settings (silo, key, value) VALUES ('*', 'digest_sent', $1::jsonb)
       ON CONFLICT (silo, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ day })]);
    const n = await sendDigests(pool);
    console.info("[engagement] digests sent", { n });
  });
  const h = setInterval(() => { void tick(); }, 5 * 60_000);
  setTimeout(() => { void tick(); }, 90_000).unref?.();
  return { stop: () => clearInterval(h) };
}
