import { pool } from "../db";

type PgError = { code?: string; message?: string };

export async function ensureOtpTableExists(): Promise<void> {
  await pool.query(`
      create table if not exists otp_verifications (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        phone text not null,
        verification_sid text,
        status text not null,
        verified_at timestamptz,
        created_at timestamptz not null default now()
      );
    `);

  const constraintResult = await pool.query(
    `
      select 1
      from pg_constraint
      where conname = $1
    `,
    ["otp_verifications_status_check"],
  );

  if (constraintResult.rowCount === 0) {
    try {
      await pool.query(`
        alter table otp_verifications
        add constraint otp_verifications_status_check
        check (status in ('pending','approved','expired'));
      `);
    } catch (err) {
      const error = err as PgError;
      if (error.code !== "42P07" && !error.message?.includes("already exists")) {
        throw err;
      }
    }
  }
}
