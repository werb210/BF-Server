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
          // BF_SERVER_ABANDON_PERMANENT_FAIL_v119
          // Retry-until-success is right for a transient outage and catastrophic
          // for a permanent rejection. An invalid number - (555) 555-5555 from a
          // test application - is rejected by Twilio every single time, so the
          // stamp never landed, the row stayed eligible, and the worker resent it
          // on every tick. That produced 264,397 billed failures against 5,427
          // real sends before anyone noticed, because a rejected message still
          // costs money.
          //
          // These codes mean the message will NEVER succeed no matter how often
          // it is tried, so the row is stamped and retired:
          //   21211 invalid To number      21614 not a mobile number
          //   21610 recipient unsubscribed 21612 unreachable via this route
          //   21408 permission denied for that region
          //   30003 handset unreachable    30005 unknown or inactive handset
          //   30006 landline or unreachable carrier
          // Anything else - network blips, rate limits, auth - still retries.
          const code = Number((err as any)?.code ?? (err as any)?.status ?? 0);
          const permanent = [21211, 21610, 21612, 21614, 21408, 30003, 30005, 30006].includes(code);

          const bumped = await pool.query<{ abandon_sms_attempts: number }>(
            `UPDATE applications SET abandon_sms_attempts = abandon_sms_attempts + 1
              WHERE id = $1 RETURNING abandon_sms_attempts`,
            [row.id],
          ).catch(() => ({ rows: [] as Array<{ abandon_sms_attempts: number }> }));
          const attempts = bumped.rows[0]?.abandon_sms_attempts ?? 0;

          // Backstop: even a failure that looks transient stops after 3 tries.
          // Without a cap, any error Twilio reports that is not on the list above
          // reproduces exactly the loop this block exists to prevent.
          if (permanent || attempts >= 3) {
            await pool.query(
              `UPDATE applications SET abandon_sms_sent_at = now() WHERE id = $1`,
              [row.id],
            ).catch(() => {});
            console.warn("[abandonedApplication] sms retired", {
              applicationId: row.id,
              code,
              attempts,
              reason: permanent ? "permanent_rejection" : "attempt_cap",
            });
          } else {
            console.warn("[abandonedApplication] sms failed, will retry", {
              applicationId: row.id, code, attempts,
            });
          }
        }
      }

      // ---- 2-day call task ---------------------------------------------
      // BF_SERVER_ABANDON_FIX_v64 - source must be one of the five allowed
      // values; these tasks are WORKFLOW. They stay findable by title.
      // tasks.type, tasks.priority AND tasks.source are all CHECK-constrained to UPPER
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
                     $4, 'WORKFLOW', NULL)`,
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
