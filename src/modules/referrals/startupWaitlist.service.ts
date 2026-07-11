// BF_SERVER_STARTUP_WAITLIST_v1 - referrals sent to the "Startup Capital" waitlist are
// messaged once, when a Startup Capital lender product is first created.
import { pool } from "../../db.js";
import { sendSms } from "../notifications/sms.service.js";

// DRAFT copy - adjust freely. Intentionally no apply link until the destination is set.
function startupSms(name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  const hi = first ? `${first}, ` : "";
  return `${hi}good news - Boreal's start-up funding is now open. You were on our start-up capital list, so we wanted you to hear first. Reply YES and we'll help you get started.`;
}

export async function notifyStartupWaitlistOnce(): Promise<{ notified: number }> {
  let notified = 0;
  try {
    const { rows } = await pool.query<{ id: string; phone: string; name: string | null }>(
      `SELECT id::text AS id, phone, name
         FROM contacts
        WHERE silo = 'BF'
          AND 'startup_capital' = ANY(coalesce(tags, '{}'))
          AND NOT ('startup_notified' = ANY(coalesce(tags, '{}')))
          AND coalesce(phone, '') <> ''`,
    );
    for (const c of rows) {
      try {
        await sendSms({ to: c.phone, message: startupSms(c.name) });
        await pool.query(
          `UPDATE contacts
              SET tags = coalesce(tags, '{}') || ARRAY['startup_notified']::text[], updated_at = now()
            WHERE id::text = $1`,
          [c.id],
        );
        notified += 1;
      } catch { /* skip; a later product create retries the un-notified ones */ }
    }
  } catch { /* best-effort */ }
  return { notified };
}
