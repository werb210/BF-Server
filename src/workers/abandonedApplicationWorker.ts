// BF_SERVER_ABANDONED_NUDGE_v61
// Todd has been manually texting every applicant who starts and does not
// finish. This does that on a schedule, and books the follow-up call.
//
//   4 hours after last activity  -> SMS asking if they have questions
//   2 days after last activity   -> task to call them
//
// Why 4 hours and not sooner: somebody who wandered off for lunch is still
// mid-application. Texting them 20 minutes in reads as surveillance.
//
// CASL: an abandoned application is an inquiry, which carries implied consent
// for six months. The 6-month ceiling below enforces that rather than relying
// on the applications table staying small. Anyone who has replied STOP is
// excluded via contacts.sms_opt_out, which smsInboundWebhook sets across all silos.
import type { Pool } from "pg";
import { sendSMS } from "../services/smsService.js";

const TICK_MS = 15 * 60_000;

const SMS_AFTER_HOURS = 4;
const CALL_TASK_AFTER_DAYS = 2;
// Implied consent from an inquiry lapses at six months under CASL. Past that we
// do not contact them at all.
const CONSENT_WINDOW_MONTHS = 6;

export const ABANDON_SMS_BODY =
  "Hi! It's Boreal Financial. We noticed you started an application but did not "
  + "complete it. Are there any questions you have before you complete your "
  + "application at client.boreal.financial? We are here to assist!";

export function startAbandonedApplicationWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // ---- 4-hour SMS --------------------------------------------------
      const due = await pool.query<{ id: string; contact_id: string | null; phone: string | null; silo: string | null }>(
        `SELECT a.id, a.contact_id, c.phone, a.silo
           FROM applications a
           JOIN contacts c ON c.id = a.contact_id
          WHERE a.submitted_at IS NULL
            AND a.abandon_sms_sent_at IS NULL
            AND a.updated_at < now() - ($1 || ' hours')::interval
            AND a.updated_at > now() - ($2 || ' months')::interval
            AND c.phone IS NOT NULL
            AND btrim(c.phone) <> ''
            AND COALESCE(c.sms_opt_out, false) = false
          ORDER BY a.updated_at ASC
          LIMIT 25`,
        [String(SMS_AFTER_HOURS), String(CONSENT_WINDOW_MONTHS)],
      );

      for (const row of due.rows) {
        if (stopped) break;
        try {
          await sendSMS(String(row.phone), ABANDON_SMS_BODY);
          // Stamped only after the send succeeds, so a Twilio outage retries on
          // the next tick instead of silently skipping the applicant.
          await pool.query(
            `UPDATE applications SET abandon_sms_sent_at = now() WHERE id = $1`,
            [row.id],
          );
        } catch (err) {
          console.warn("[abandonedApplication] sms failed", { applicationId: row.id, err: String(err) });
        }
      }

      // ---- 2-day call task ---------------------------------------------
      // tasks.type and tasks.priority are both CHECK-constrained to UPPER
      // case: type IN ('CALL','EMAIL','SMS','TODO'),
      // priority IN ('NONE','LOW','MEDIUM','HIGH'). See 2026_07_04_tasks_v1.sql.
      const callDue = await pool.query<{ id: string; contact_id: string; silo: string | null; phone: string | null }>(
        `SELECT a.id, a.contact_id, a.silo, c.phone
           FROM applications a
           JOIN contacts c ON c.id = a.contact_id
          WHERE a.submitted_at IS NULL
            AND a.abandon_task_created_at IS NULL
            AND a.updated_at < now() - ($1 || ' days')::interval
            AND a.updated_at > now() - ($2 || ' months')::interval
          ORDER BY a.updated_at ASC
          LIMIT 25`,
        [String(CALL_TASK_AFTER_DAYS), String(CONSENT_WINDOW_MONTHS)],
      );

      for (const row of callDue.rows) {
        if (stopped) break;
        try {
          await pool.query(
            `INSERT INTO tasks (silo, title, body, type, priority, due_at, assignee_user_id, contact_id, source, source_ref_id)
             VALUES ($1, $2, $3, 'CALL', 'HIGH', now(),
                     COALESCE((SELECT owner_id FROM contacts WHERE id = $4),
                              (SELECT id FROM users
                                WHERE active = true
                                  AND id::text <> '00000000-0000-0000-0000-000000000099'
                                ORDER BY (role = 'Admin') DESC, created_at ASC
                                LIMIT 1)),
                     $4, 'ABANDONED_APPLICATION', NULL)`,
            [
              row.silo || "BF",
              "Call: started an application, did not finish",
              `Started an application two days ago and has not submitted. An SMS `
                + `was sent after 4 hours. Phone: ${row.phone ?? "unknown"}.`,
              row.contact_id,
            ],
          );
          await pool.query(
            `UPDATE applications SET abandon_task_created_at = now() WHERE id = $1`,
            [row.id],
          );
        } catch (err) {
          console.warn("[abandonedApplication] task failed", { applicationId: row.id, err: String(err) });
        }
      }
    } catch (err) {
      console.warn("[abandonedApplication] tick failed", String(err));
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
