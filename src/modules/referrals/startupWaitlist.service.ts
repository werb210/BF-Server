// BF_SERVER_STARTUP_WAITLIST_v1 - referrals sent to the "Startup Capital" waitlist are
// messaged once, when a Startup Capital lender product is first created.
import { pool } from "../../db.js";
import { sendSms } from "../notifications/sms.service.js";
import { referralLandingUrl } from "./referralInvite.js";

// DRAFT copy - adjust freely. Start-up funding becomes regular funding once open, so the
// link is the BF-Website funding landing (/r/f/<code>).
function startupSms(name: string | null, refCode: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  const hi = first ? `${first}, ` : "";
  const link = refCode ? `\n${referralLandingUrl(["BF"], refCode)}` : "";
  return `${hi}good news - Boreal's start-up funding is now open. You were on our start-up capital list, so we wanted you to hear first. Apply here:${link}`;
}

export async function notifyStartupWaitlistOnce(): Promise<{ notified: number }> {
  let notified = 0;
  try {
    const { rows } = await pool.query<{ id: string; phone: string; name: string | null; ref_code: string | null }>(
      `SELECT id::text AS id, phone, name, ref_code
         FROM contacts
        WHERE silo = 'BF'
          AND 'startup_capital' = ANY(coalesce(tags, '{}'))
          AND NOT ('startup_notified' = ANY(coalesce(tags, '{}')))
          AND coalesce(phone, '') <> ''`,
    );
    for (const c of rows) {
      try {
        await sendSms({ to: c.phone, message: startupSms(c.name, c.ref_code) });
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
