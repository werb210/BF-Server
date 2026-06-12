import { Router } from "express";
import { safeHandler } from "../../middleware/safeHandler.js";
import { dbQuery } from "../../db.js";

// BF_SERVER_BLOCK_v842_SUBMIT_ATTEMPTS
// Fire-and-forget beacon from the client: "attempted" the instant Submit is
// tapped, then "completed" on success. Rows stuck at "attempted" are the
// submissions that never reached the server — the previously-invisible failures.

export type SubmitAttemptInput = {
  applicationToken?: unknown;
  phone?: unknown;
  email?: unknown;
  businessName?: unknown;
  status?: unknown;
  error?: unknown;
  userAgent?: string | null;
  silo?: string | null;
};

const s = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length ? v.slice(0, max) : null;

// Pure query builder — unit-tested without a DB.
export function buildSubmitAttemptWrite(input: SubmitAttemptInput): {
  sql: string;
  params: unknown[];
} {
  const token =
    typeof input.applicationToken === "string" ? input.applicationToken.trim() : "";
  const status =
    input.status === "completed" || input.status === "failed" ? input.status : "attempted";
  const phone = s(input.phone, 32);
  const email = s(input.email, 256);
  const businessName = s(input.businessName, 256);
  const error = s(input.error, 1000);
  const userAgent = s(input.userAgent, 512);
  const silo = typeof input.silo === "string" && input.silo ? input.silo : "BF";

  if (token) {
    return {
      sql: `INSERT INTO submit_attempts
              (application_token, phone, email, business_name, status, error, user_agent, silo)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (application_token) DO UPDATE SET
              status        = CASE WHEN submit_attempts.status = 'completed'
                                   THEN 'completed' ELSE EXCLUDED.status END,
              phone         = COALESCE(EXCLUDED.phone, submit_attempts.phone),
              email         = COALESCE(EXCLUDED.email, submit_attempts.email),
              business_name = COALESCE(EXCLUDED.business_name, submit_attempts.business_name),
              error         = COALESCE(EXCLUDED.error, submit_attempts.error),
              user_agent    = COALESCE(EXCLUDED.user_agent, submit_attempts.user_agent),
              updated_at    = now()`,
      params: [token, phone, email, businessName, status, error, userAgent, silo],
    };
  }
  return {
    sql: `INSERT INTO submit_attempts
            (phone, email, business_name, status, error, user_agent, silo)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    params: [phone, email, businessName, status, error, userAgent, silo],
  };
}

const router = Router();

router.post(
  "/submit-attempts",
  safeHandler(async (req: any, res: any) => {
    const ua = req.headers?.["user-agent"];
    const { sql, params } = buildSubmitAttemptWrite({
      ...(req.body ?? {}),
      userAgent: typeof ua === "string" ? ua : null,
      silo: (req as any).silo ?? "BF",
    });
    await dbQuery(sql, params);
    res.json({ ok: true });
  }),
);

export default router;
