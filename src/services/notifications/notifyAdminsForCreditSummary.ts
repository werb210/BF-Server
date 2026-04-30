import type { Pool } from "pg";
import { sendSMS } from "../smsService.js";

export type NotifyCtx = {
  pool: Pool;
  applicationId: string;
};

export async function notifyAdminsForCreditSummary(ctx: NotifyCtx): Promise<{
  smsSent: number;
  notifsCreated: number;
}> {
  const id = ctx.applicationId;
  if (!id) return { smsSent: 0, notifsCreated: 0 };

  const appRow = await ctx.pool.query<{
    name: string | null;
    requested_amount: string | number | null;
  }>(
    `SELECT name, requested_amount
       FROM applications WHERE id::text = $1 LIMIT 1`,
    [id]
  ).catch(() => ({ rows: [] as Array<{ name: string | null; requested_amount: string | number | null }> }));

  const appName = appRow.rows[0]?.name ?? id;
  const amountRaw = appRow.rows[0]?.requested_amount ?? null;
  const amountText = amountRaw === null || amountRaw === undefined
    ? ""
    : ` ($${Number(amountRaw).toLocaleString("en-US", { maximumFractionDigits: 0 })})`;
  const body =
    `Boreal: ${appName}${amountText} is ready for credit summary + signing. ` +
    "Open the staff portal to continue.";

  const admins = await ctx.pool.query<{
    id: string;
    phone_number: string | null;
    email: string | null;
  }>(
    `SELECT id::text AS id, phone_number, email
       FROM users
      WHERE active = true
        AND upper(coalesce(role, '')) = 'ADMIN'`
  ).catch(() => ({ rows: [] as Array<{ id: string; phone_number: string | null; email: string | null }> }));

  let smsSent = 0;
  let notifsCreated = 0;

  await Promise.all(
    admins.rows.map(async (admin) => {
      if (admin.phone_number && admin.phone_number.trim().length > 0) {
        try {
          const r = await sendSMS(admin.phone_number, body);
          if (r && (r as { success?: boolean }).success) smsSent += 1;
          else if (!r) smsSent += 1;
        } catch (err) {
          console.warn(`[notifyAdmins] sms failed for user=${admin.id}`, err);
        }
      }

      try {
        await ctx.pool.query(
          `INSERT INTO notifications
             (id, user_id, type, ref_table, ref_id, body, context_url, is_read, created_at)
           VALUES (gen_random_uuid(), $1, 'credit_summary_ready', 'applications', $2, $3, $4, false, now())`,
          [
            admin.id,
            id,
            body,
            `/applications/${encodeURIComponent(id)}`,
          ]
        );
        notifsCreated += 1;
      } catch (err) {
        console.warn(`[notifyAdmins] notification insert failed for user=${admin.id}`, err);
      }
    })
  );

  console.log(
    `[notifyAdmins] application=${id} admins=${admins.rows.length} smsSent=${smsSent} notifsCreated=${notifsCreated}`
  );
  return { smsSent, notifsCreated };
}
