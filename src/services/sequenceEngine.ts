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
  try {
    const r = await pool.query(`SELECT 1 FROM crm_email_log WHERE contact_id=$1 AND opened_at IS NOT NULL AND opened_at > $2
                                UNION ALL SELECT 1 FROM crm_timeline_events WHERE contact_id=$1 AND event_type='email_open' AND created_at > $2 LIMIT 1`, [contactId, since]);
    return (r.rowCount ?? 0) > 0;
  } catch { return false; }
}
async function clickedSince(pool: Pool, contactId: string, since: any): Promise<boolean> {
  try {
    const r = await pool.query(`SELECT 1 FROM sms_campaign_sends WHERE contact_id=$1 AND clicked_at IS NOT NULL AND clicked_at > $2
                                UNION ALL SELECT 1 FROM sequence_sends WHERE contact_id=$1 AND clicked_at IS NOT NULL AND clicked_at > $2
                                UNION ALL SELECT 1 FROM crm_timeline_events WHERE contact_id=$1 AND event_type='email_click' AND created_at > $2 LIMIT 1`, [contactId, since]);
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

// BF_SERVER_SEQ_TASK_STEP_v1 - called by the tasks routes when a
// SEQUENCE-sourced task completes: un-parks the enrollment and advances.
export async function resumeSequenceTask(pool: Pool, enrollmentId: string): Promise<void> {
  const en = (await pool.query(
    `SELECT id, sequence_id, current_step FROM marketing_sequence_enrollments WHERE id=$1 AND status='waiting_task'`,
    [enrollmentId]
  )).rows[0];
  if (!en) return;
  const steps = (await pool.query(
    `SELECT channel, wait_minutes FROM marketing_sequence_steps WHERE sequence_id=$1 ORDER BY step_order ASC`,
    [en.sequence_id]
  )).rows;
  await advance(pool, en.id, Number(en.current_step) + 1, steps);
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
  const steps = (await pool.query(`SELECT channel, wait_minutes, condition, subject, body, html, link_url, template_id, task_type, task_priority, task_queue_id, task_pause FROM marketing_sequence_steps WHERE sequence_id=$1 ORDER BY step_order ASC`, [en.sequence_id])).rows;
  const idx: number = en.current_step;
  if (idx >= steps.length) { await complete(pool, en.id); return; }
  const step = steps[idx];
  const since = en.last_step_at || en.enrolled_at;
  // BF_SERVER_BLOCK_v788_SEQ_TEMPLATES - resolve step content from a saved template.
  let effSubject = step.subject, effBody = step.body, effHtml = step.html, effLink = step.link_url;
  if (step.template_id) {
    const t = await pool.query(`SELECT subject, body, html, link_url FROM marketing_template WHERE id=$1`, [step.template_id]);
    if (t.rows[0]) { effSubject = t.rows[0].subject; effBody = t.rows[0].body; effHtml = t.rows[0].html; effLink = t.rows[0].link_url; }
  }

  if (en.stop_on_reply && (await repliedSince(pool, en.contact_id, en.enrolled_at))) { await stop(pool, en.id, "replied"); return; }

  const cq = await pool.query(`SELECT id, silo, owner_id, email, phone, name, COALESCE(sms_opt_out,false) AS sms_opt_out, COALESCE(marketing_opt_out,false) AS marketing_opt_out, line_type, (SELECT name FROM companies WHERE id=contacts.company_id) AS company FROM contacts WHERE id=$1`, [en.contact_id]);
  const c = cq.rows[0];
  if (!c) { await complete(pool, en.id); return; }

  let skipSend = false;
  if (step.condition === "if_no_reply" && (await repliedSince(pool, c.id, since))) skipSend = true;
  else if (step.condition === "if_no_open" && (await openedSince(pool, c.id, since))) skipSend = true;
  else if (step.condition === "if_no_click" && (await clickedSince(pool, c.id, since))) skipSend = true;

  if (!skipSend) {
    const first = String(c.name || "").trim().split(/\s+/)[0] || "there";
    const vars = { first_name: first, name: c.name || "there", email: c.email || "", company: c.company || "" };
    // BF_SERVER_SEQ_TASK_STEP_v1 (Tasks M5) - a "task" step creates a tasks
    // row (source=SEQUENCE, source_ref_id=enrollment) assigned to the
    // contact's owner (admin fallback). If task_pause (default), the
    // enrollment parks as status='waiting_task' until the task is completed,
    // which calls resumeSequenceTask below; otherwise it advances normally.
    if (step.channel === "task") {
      if (!skipSend) {
        const tt = ["CALL", "EMAIL", "SMS", "TODO"].includes(step.task_type) ? step.task_type : "TODO";
        const tp = ["NONE", "LOW", "MEDIUM", "HIGH"].includes(step.task_priority) ? step.task_priority : "NONE";
        const title = mergeFields(String(effSubject || `${tt} ${c.name || "contact"}`), vars);
        const notes = effBody ? mergeFields(String(effBody), vars) : null;
        const siloVal = c.silo || "BF";
        await pool.query(
          `INSERT INTO tasks (silo, title, body, type, priority, due_at, queue_id, assignee_user_id, contact_id, source, source_ref_id)
           VALUES ($1,$2,$3,$4,$5,now(),
                   (SELECT id FROM task_queues WHERE id = $6::uuid AND silo = $1),
                   COALESCE($7::uuid, (SELECT id FROM users WHERE active = true ORDER BY (role = 'Admin') DESC, created_at ASC LIMIT 1)),
                   $8, 'SEQUENCE', $9::uuid)`,
          [siloVal, title, notes, tt, tp, step.task_queue_id ?? null, c.owner_id ?? null, c.id, en.id]
        );
        await logStep(pool, c.id, en.sequence_id, idx, "task");
      }
      if (!skipSend && step.task_pause !== false) {
        await pool.query(`UPDATE marketing_sequence_enrollments SET status='waiting_task', updated_at=now() WHERE id=$1`, [en.id]);
        return;
      }
      await advance(pool, en.id, idx + 1, steps);
      return;
    }

    if (step.channel === "sms") {
      const blocked = !c.phone || c.sms_opt_out || (c.line_type && c.line_type !== "mobile");
      if (!blocked) {
        const h = smsHourLocal();
        if (h < en.quiet_start || h >= en.quiet_end) { await bump(pool, en.id, 60); return; }
        // BF_SERVER_BLOCK_v786_SEQ_CLICKS - track this send so a link click attributes back.
        const ss = await pool.query<{ id: string }>(`INSERT INTO sequence_sends (sequence_id, contact_id, silo, channel) VALUES ($1,$2,$3,'sms') RETURNING id`, [en.sequence_id, c.id, c.silo || "BF"]);
        const sendId = ss.rows[0]?.id || randomUUID();
        const text = effLink ? `${effBody || ""} ${trackedLink(sendId, String(effLink))}` : String(effBody || "");
        const r = await sendMarketingSms(String(c.phone), text);
        if (r.ok) { await logStep(pool, c.id, en.sequence_id, idx, "sms"); await pool.query(`UPDATE sequence_sends SET message_sid=$2 WHERE id=$1`, [sendId, r.sid ?? null]).catch(() => {}); }
        else if (r.optedOut) await pool.query(`UPDATE contacts SET sms_opt_out=true, updated_at=now() WHERE id=$1`, [c.id]).catch(() => {});
        else {
          // BF_SERVER_SEQ_NO_ADVANCE_ON_SEND_FAIL_v1 - see email branch.
          await pool.query(`DELETE FROM sequence_sends WHERE id=$1`, [sendId]).catch(() => {});
          console.error("[sequence] sms send failed; will retry", { enrollmentId: en.id });
          await bump(pool, en.id, 60);
          return;
        }
      }
    } else {
      const blocked = !c.email || c.marketing_opt_out;
      if (!blocked) {
        const html = effHtml && String(effHtml).trim()
          ? String(effHtml)
          : renderBrandedEmail({ headline: "", heroUrl: "", heroLink: "", body: String(effBody || ""), ctaLabel: "", ctaUrl: "", image2Url: "", image2Link: "" });
        // BF_SERVER_BLOCK_v790 - track the email send so SendGrid opens/clicks attribute per-sequence.
        const es = await pool.query<{ id: string }>(`INSERT INTO sequence_sends (sequence_id, contact_id, silo, channel) VALUES ($1,$2,$3,'email') RETURNING id`, [en.sequence_id, c.id, c.silo || "BF"]);
        const esId = es.rows[0]?.id || "";
        const r = await sendOne({ to: String(c.email), subject: mergeFields(String(effSubject || ""), vars), html: mergeFields(html, vars), contactId: c.id, customArgs: esId ? { seq_send_id: esId } : undefined });
        if (r.ok) await logStep(pool, c.id, en.sequence_id, idx, "email");
        else {
          // BF_SERVER_SEQ_NO_ADVANCE_ON_SEND_FAIL_v1 - a failed send (e.g.
          // SendGrid 401 on a dead key) used to advance/complete the
          // enrollment anyway, and the pre-inserted sequence_sends row made
          // analytics count it as a sent email. The July 3rd blast reported
          // 805 emails / 1637 done while SendGrid rejected everything.
          // Remove the attempt row and retry this step in 60 minutes.
          if (esId) await pool.query(`DELETE FROM sequence_sends WHERE id=$1`, [esId]).catch(() => {});
          console.error("[sequence] email send failed; will retry", { enrollmentId: en.id, status: r.status, error: r.error });
          await bump(pool, en.id, 60);
          return;
        }
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
