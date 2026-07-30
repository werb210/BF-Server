// BF_SERVER_BLOCK_v785_SEQUENCES — per-contact drip engine. Mirrors the send-queue
// claim pattern (atomic status flip, safe across instances). Stop-on-reply,
// suppression, SMS quiet-hours, and per-step conditions all enforced here.
import type { Pool } from "pg";
import { randomUUID } from "crypto";
import { sendOne, mergeFields } from "./sendgridService.js";
import { renderMarketingSms, sendMarketingSms, trackedLink, lookupLineType } from "./marketingSms.js";
import { renderBrandedEmail } from "./emailTemplateRender.js";
import { isCanadianMobile } from "./smsConsent.js";
import { scheduleAfter } from "./sequenceSchedule.js";
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
async function bump(pool: Pool, id: string, minutes: number, quietStart: number, quietEnd: number): Promise<void> { await pool.query(`UPDATE marketing_sequence_enrollments SET status='active', next_run_at=$2, updated_at=now() WHERE id=$1`, [id, scheduleAfter(minutes, quietStart, quietEnd)]); }
async function advance(pool: Pool, id: string, nextIdx: number, steps: any[], quietStart: number, quietEnd: number): Promise<void> {
  if (nextIdx >= steps.length) { await complete(pool, id); return; }
  const wait = steps[nextIdx]?.wait_minutes ?? 0;
  await pool.query(`UPDATE marketing_sequence_enrollments SET status='active', current_step=$2, last_step_at=now(), next_run_at=$3, updated_at=now() WHERE id=$1`, [id, nextIdx, scheduleAfter(wait, quietStart, quietEnd)]);
}

// BF_SERVER_SEQ_TASK_STEP_v1 - called by the tasks routes when a
// SEQUENCE-sourced task completes: un-parks the enrollment and advances.
export async function resumeSequenceTask(pool: Pool, enrollmentId: string): Promise<void> {
  const en = (await pool.query(
    `SELECT e.id, e.sequence_id, e.current_step, s.quiet_start, s.quiet_end FROM marketing_sequence_enrollments e JOIN marketing_sequences s ON s.id=e.sequence_id WHERE e.id=$1 AND e.status='waiting_task'`,
    [enrollmentId]
  )).rows[0];
  if (!en) return;
  const steps = (await pool.query(
    `SELECT channel, wait_minutes FROM marketing_sequence_steps WHERE sequence_id=$1 ORDER BY step_order ASC`,
    [en.sequence_id]
  )).rows;
  await advance(pool, en.id, Number(en.current_step) + 1, steps, en.quiet_start, en.quiet_end);
}

export async function enrollSequence(pool: Pool, sequenceId: string): Promise<number> {
  const seq = await pool.query(`SELECT silo, audience_tag, quiet_start, quiet_end FROM marketing_sequences WHERE id=$1`, [sequenceId]);
  if (seq.rowCount === 0) return 0;
  const silo = seq.rows[0].silo; const tag = seq.rows[0].audience_tag;
  const fw = await pool.query(`SELECT wait_minutes FROM marketing_sequence_steps WHERE sequence_id=$1 ORDER BY step_order ASC LIMIT 1`, [sequenceId]);
  const wait = fw.rows[0]?.wait_minutes ?? 0;
  const ins = await pool.query(
    `INSERT INTO marketing_sequence_enrollments (sequence_id, contact_id, silo, current_step, status, next_run_at, enrolled_at)
       SELECT $1, c.id, $2, 0, 'active', $3, now()
         FROM contacts c
        WHERE c.silo=$2 AND ($4::text IS NULL OR $4 = ANY(c.tags))
          AND (COALESCE(c.email,'')<>'' OR COALESCE(c.phone,'')<>'')
     ON CONFLICT (sequence_id, contact_id) DO NOTHING`,
    [sequenceId, silo, scheduleAfter(wait, seq.rows[0].quiet_start, seq.rows[0].quiet_end), tag],
  );
  return ins.rowCount ?? 0;
}


// BF_SERVER_SEQ_ENROLL_CONTACTS_v1 - explicit, idempotent list-view enrollment.
export async function enrollContacts(pool: Pool, sequenceId: string, contactIds: string[]): Promise<number> {
  if (!contactIds.length) return 0;
  const seq = await pool.query(`SELECT silo, quiet_start, quiet_end FROM marketing_sequences WHERE id=$1`, [sequenceId]);
  if (!seq.rows[0]) return 0;
  const first = await pool.query(`SELECT wait_minutes FROM marketing_sequence_steps WHERE sequence_id=$1 ORDER BY step_order ASC LIMIT 1`, [sequenceId]);
  const nextRun = scheduleAfter(first.rows[0]?.wait_minutes ?? 0, seq.rows[0].quiet_start, seq.rows[0].quiet_end);
  const inserted = await pool.query(
    `INSERT INTO marketing_sequence_enrollments (sequence_id, contact_id, silo, current_step, status, next_run_at, enrolled_at)
       SELECT $1, c.id, $2, 0, 'active', $3, now() FROM contacts c
        WHERE c.id = ANY($4::uuid[]) AND c.silo=$2 AND (COALESCE(c.email,'')<>'' OR COALESCE(c.phone,'')<>'')
     ON CONFLICT (sequence_id, contact_id) DO NOTHING`,
    [sequenceId, seq.rows[0].silo, nextRun, contactIds],
  );
  return inserted.rowCount ?? 0;
}

async function processClaimed(pool: Pool, en: any): Promise<void> {
  const steps = (await pool.query(`SELECT channel, wait_minutes, condition, subject, body, html, link_url, template_id, sms_template_id, email_template_id, task_type, task_priority, task_queue_id, task_pause FROM marketing_sequence_steps WHERE sequence_id=$1 ORDER BY step_order ASC`, [en.sequence_id])).rows;
  const idx: number = en.current_step;
  if (idx >= steps.length) { await complete(pool, en.id); return; }
  const step = steps[idx];
  const since = en.last_step_at || en.enrolled_at;
  // BF_SERVER_BLOCK_v788_SEQ_TEMPLATES - resolve step content from a saved template.
  let effSubject = step.subject, effBody = step.body, effHtml = step.html, effLink = step.link_url;
  // BF_SERVER_SEQ_AUTO_TEMPLATES_v1 - template resolution is deferred for an
  // auto step: which template applies depends on the branch this contact takes,
  // and that is not known until textability has been evaluated below. A single
  // template_id could never serve both - an email template texted as SMS ships
  // raw HTML, an SMS template emailed ships a subject-less one-liner.
  const applyTemplate = async (templateId: string | null | undefined): Promise<void> => {
    if (!templateId) return;
    const t = await pool.query(`SELECT subject, body, html, link_url FROM marketing_template WHERE id=$1`, [templateId]);
    if (t.rows[0]) { effSubject = t.rows[0].subject; effBody = t.rows[0].body; effHtml = t.rows[0].html; effLink = t.rows[0].link_url; }
  };
  if (step.channel !== "auto") await applyTemplate(step.template_id);

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
      await advance(pool, en.id, idx + 1, steps, en.quiet_start, en.quiet_end);
      return;
    }

    // BF_SERVER_SEQ_AUTO_CHANNEL_v1 - exactly the blast runner's textability
    // rule. Auto selects one branch only, preferring SMS when both are present.
    let textable = Boolean(c.phone) && !c.sms_opt_out && !c.marketing_opt_out && isCanadianMobile(c.phone);
    if (textable && c.line_type == null) {
      const lineType = await lookupLineType(String(c.phone));
      if (lineType) await pool.query(`UPDATE contacts SET line_type=$2, line_type_checked_at=now() WHERE id=$1`, [c.id, lineType]);
      if (lineType && lineType !== "mobile") textable = false;
    } else if (textable && c.line_type !== "mobile") textable = false;
    const channel = step.channel === "auto" ? (textable ? "sms" : "email") : step.channel;
    // BF_SERVER_SEQ_AUTO_TEMPLATES_v1 - now that the branch is known, load the
    // template written for THAT channel.
    if (step.channel === "auto") {
      await applyTemplate(channel === "sms" ? step.sms_template_id : step.email_template_id);
    }
    if (channel === "sms") {
      const blocked = !textable;
      if (!blocked) {
        // BF_SERVER_BLOCK_v786_SEQ_CLICKS - track this send so a link click attributes back.
        const ss = await pool.query<{ id: string }>(`INSERT INTO sequence_sends (sequence_id, contact_id, silo, channel) VALUES ($1,$2,$3,'sms') RETURNING id`, [en.sequence_id, c.id, c.silo || "BF"]);
        const sendId = ss.rows[0]?.id || randomUUID();
        const text = renderMarketingSms({
          body: String(effBody || ""),
          vars,
          link: effLink ? trackedLink(sendId, String(effLink)) : null,
        });
        const r = await sendMarketingSms(String(c.phone), text);
        if (r.ok) { await logStep(pool, c.id, en.sequence_id, idx, "sms"); await pool.query(`UPDATE sequence_sends SET message_sid=$2 WHERE id=$1`, [sendId, r.sid ?? null]).catch(() => {}); }
        else if (r.optedOut) await pool.query(`UPDATE contacts SET sms_opt_out=true, updated_at=now() WHERE id=$1`, [c.id]).catch(() => {});
        else {
          // BF_SERVER_SEQ_NO_ADVANCE_ON_SEND_FAIL_v1 - see email branch.
          await pool.query(`DELETE FROM sequence_sends WHERE id=$1`, [sendId]).catch(() => {});
          console.error("[sequence] sms send failed; will retry", { enrollmentId: en.id });
          await bump(pool, en.id, 60, en.quiet_start, en.quiet_end);
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
          await bump(pool, en.id, 60, en.quiet_start, en.quiet_end);
          return;
        }
      }
    }
  }
  await advance(pool, en.id, idx + 1, steps, en.quiet_start, en.quiet_end);
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
    catch { await pool.query(`UPDATE marketing_sequence_enrollments SET status='active', next_run_at=$2, updated_at=now() WHERE id=$1`, [en.id, scheduleAfter(15, en.quiet_start, en.quiet_end)]).catch(() => {}); }
  }
}
