// BF_SERVER_BLOCK_v785_SEQUENCES — per-contact drip engine. Mirrors the send-queue
// claim pattern (atomic status flip, safe across instances). Stop-on-reply,
// suppression, SMS quiet-hours, and per-step conditions all enforced here.
import type { Pool } from "pg";
import { randomUUID } from "crypto";
import { sendOne, mergeFields } from "./sendgridService.js";
import { sendMarketingSms, trackedLink } from "./marketingSms.js";
import { renderBrandedEmail } from "./emailTemplateRender.js";

function smsHourLocal(): number {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Edmonton", hour: "numeric", hour12: false }).format(new Date()));
  return h % 24;
}
async function repliedSince(pool: Pool, contactId: string, since: any): Promise<boolean> {
  try { const r = await pool.query(`SELECT 1 FROM communications_messages WHERE contact_id=$1 AND direction='inbound' AND created_at > $2 LIMIT 1`, [contactId, since]); return (r.rowCount ?? 0) > 0; }
  catch { return false; }
}
async function openedSince(pool: Pool, contactId: string, since: any): Promise<boolean> {
  try { const r = await pool.query(`SELECT 1 FROM crm_email_log WHERE contact_id=$1 AND opened_at IS NOT NULL AND opened_at > $2 LIMIT 1`, [contactId, since]); return (r.rowCount ?? 0) > 0; }
  catch { return false; }
}
async function clickedSince(pool: Pool, contactId: string, since: any): Promise<boolean> {
  try {
    const r = await pool.query(`SELECT 1 FROM sms_campaign_sends WHERE contact_id=$1 AND clicked_at IS NOT NULL AND clicked_at > $2
                                UNION ALL SELECT 1 FROM sequence_sends WHERE contact_id=$1 AND clicked_at IS NOT NULL AND clicked_at > $2 LIMIT 1`, [contactId, since]);
    return (r.rowCount ?? 0) > 0;
  } catch { return false; }
}
async function logStep(pool: Pool, contactId: string, seqId: string, stepIdx: number, channel: string): Promise<void> {
  await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [contactId, "sequence_step_sent", JSON.stringify({ sequenceId: seqId, step: stepIdx, channel })]).catch(() => {});
}
async function complete(pool: Pool, id: string): Promise<void> { await pool.query(`UPDATE marketing_sequence_enrollments SET status='completed', last_step_at=now(), updated_at=now() WHERE id=$1`, [id]); }
async function stop(pool: Pool, id: string, status: string): Promise<void> { await pool.query(`UPDATE marketing_sequence_enrollments SET status=$2, updated_at=now() WHERE id=$1`, [id, status]); }
async function bump(pool: Pool, id: string, minutes: number): Promise<void> { await pool.query(`UPDATE marketing_sequence_enrollments SET status='active', next_run_at=now()+($2||' minutes')::interval, updated_at=now() WHERE id=$1`, [id, String(minutes)]); }
async function advance(pool: Pool, id: string, nextIdx: number, steps: any[]): Promise<void> {
  if (nextIdx >= steps.length) { await complete(pool, id); return; }
  const wait = steps[nextIdx]?.wait_minutes ?? 0;
  await pool.query(`UPDATE marketing_sequence_enrollments SET status='active', current_step=$2, last_step_at=now(), next_run_at=now()+($3||' minutes')::interval, updated_at=now() WHERE id=$1`, [id, nextIdx, String(wait)]);
}

export async function enrollSequence(pool: Pool, sequenceId: string): Promise<number> {
  const seq = await pool.query(`SELECT silo, audience_tag FROM marketing_sequences WHERE id=$1`, [sequenceId]);
  if (seq.rowCount === 0) return 0;
  const silo = seq.rows[0].silo; const tag = seq.rows[0].audience_tag;
  const fw = await pool.query(`SELECT wait_minutes FROM marketing_sequence_steps WHERE sequence_id=$1 ORDER BY step_order ASC LIMIT 1`, [sequenceId]);
  const wait = fw.rows[0]?.wait_minutes ?? 0;
  const ins = await pool.query(
    `INSERT INTO marketing_sequence_enrollments (sequence_id, contact_id, silo, current_step, status, next_run_at, enrolled_at)
       SELECT $1, c.id, $2, 0, 'active', now()+($3||' minutes')::interval, now()
         FROM contacts c
        WHERE c.silo=$2 AND ($4::text IS NULL OR $4 = ANY(c.tags))
          AND (COALESCE(c.email,'')<>'' OR COALESCE(c.phone,'')<>'')
     ON CONFLICT (sequence_id, contact_id) DO NOTHING`,
    [sequenceId, silo, String(wait), tag],
  );
  return ins.rowCount ?? 0;
}

async function processClaimed(pool: Pool, en: any): Promise<void> {
  const steps = (await pool.query(`SELECT channel, wait_minutes, condition, subject, body, html, link_url FROM marketing_sequence_steps WHERE sequence_id=$1 ORDER BY step_order ASC`, [en.sequence_id])).rows;
  const idx: number = en.current_step;
  if (idx >= steps.length) { await complete(pool, en.id); return; }
  const step = steps[idx];
  const since = en.last_step_at || en.enrolled_at;

  if (en.stop_on_reply && (await repliedSince(pool, en.contact_id, en.enrolled_at))) { await stop(pool, en.id, "replied"); return; }

  const cq = await pool.query(`SELECT id, silo, email, phone, name, COALESCE(sms_opt_out,false) AS sms_opt_out, COALESCE(marketing_opt_out,false) AS marketing_opt_out, line_type, (SELECT name FROM companies WHERE id=contacts.company_id) AS company FROM contacts WHERE id=$1`, [en.contact_id]);
  const c = cq.rows[0];
  if (!c) { await complete(pool, en.id); return; }

  let skipSend = false;
  if (step.condition === "if_no_reply" && (await repliedSince(pool, c.id, since))) skipSend = true;
  else if (step.condition === "if_no_open" && (await openedSince(pool, c.id, since))) skipSend = true;
  else if (step.condition === "if_no_click" && (await clickedSince(pool, c.id, since))) skipSend = true;

  if (!skipSend) {
    const first = String(c.name || "").trim().split(/\s+/)[0] || "there";
    const vars = { first_name: first, name: c.name || "there", email: c.email || "", company: c.company || "" };
    if (step.channel === "sms") {
      const blocked = !c.phone || c.sms_opt_out || (c.line_type && c.line_type !== "mobile");
      if (!blocked) {
        const h = smsHourLocal();
        if (h < en.quiet_start || h >= en.quiet_end) { await bump(pool, en.id, 60); return; }
        // BF_SERVER_BLOCK_v786_SEQ_CLICKS - track this send so a link click attributes back.
        const ss = await pool.query<{ id: string }>(`INSERT INTO sequence_sends (sequence_id, contact_id, silo, channel) VALUES ($1,$2,$3,'sms') RETURNING id`, [en.sequence_id, c.id, c.silo || "BF"]);
        const sendId = ss.rows[0]?.id || randomUUID();
        const text = step.link_url ? `${step.body || ""} ${trackedLink(sendId, String(step.link_url))}` : String(step.body || "");
        const r = await sendMarketingSms(String(c.phone), text);
        if (r.ok) { await logStep(pool, c.id, en.sequence_id, idx, "sms"); await pool.query(`UPDATE sequence_sends SET message_sid=$2 WHERE id=$1`, [sendId, r.sid ?? null]).catch(() => {}); }
        else if (r.optedOut) await pool.query(`UPDATE contacts SET sms_opt_out=true, updated_at=now() WHERE id=$1`, [c.id]).catch(() => {});
      }
    } else {
      const blocked = !c.email || c.marketing_opt_out;
      if (!blocked) {
        const html = step.html && String(step.html).trim()
          ? String(step.html)
          : renderBrandedEmail({ headline: "", heroUrl: "", heroLink: "", body: String(step.body || ""), ctaLabel: "", ctaUrl: "", image2Url: "", image2Link: "" });
        const r = await sendOne({ to: String(c.email), subject: mergeFields(String(step.subject || ""), vars), html: mergeFields(html, vars), contactId: c.id });
        if (r.ok) await logStep(pool, c.id, en.sequence_id, idx, "email");
      }
    }
  }
  await advance(pool, en.id, idx + 1, steps);
}

export async function tickSequences(pool: Pool): Promise<void> {
  for (let i = 0; i < 25; i++) {
    const claim = await pool.query(
      `UPDATE marketing_sequence_enrollments SET status='running', updated_at=now()
        WHERE id = (
          SELECT e.id FROM marketing_sequence_enrollments e
            JOIN marketing_sequences s ON s.id = e.sequence_id
           WHERE (e.status='active' OR (e.status='running' AND e.updated_at < now() - interval '10 minutes'))
             AND e.next_run_at <= now() AND s.status='active'
           ORDER BY e.next_run_at ASC
           FOR UPDATE OF e SKIP LOCKED LIMIT 1)
        RETURNING id, sequence_id, contact_id, current_step, enrolled_at, last_step_at,
          (SELECT stop_on_reply FROM marketing_sequences WHERE id=marketing_sequence_enrollments.sequence_id) AS stop_on_reply,
          (SELECT quiet_start FROM marketing_sequences WHERE id=marketing_sequence_enrollments.sequence_id) AS quiet_start,
          (SELECT quiet_end   FROM marketing_sequences WHERE id=marketing_sequence_enrollments.sequence_id) AS quiet_end`,
    );
    const en = claim.rows[0];
    if (!en) break;
    try { await processClaimed(pool, en); }
    catch { await pool.query(`UPDATE marketing_sequence_enrollments SET status='active', next_run_at=now()+interval '15 minutes', updated_at=now() WHERE id=$1`, [en.id]).catch(() => {}); }
  }
}
