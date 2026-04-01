"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureOtpTableExists = ensureOtpTableExists;
const db_1 = require("../db");
async function ensureOtpTableExists() {
    const tableResult = await db_1.pool.runQuery(`
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'otp_verifications'
      limit 1
    `);
    if (tableResult.rowCount === 0) {
        try {
            await db_1.pool.runQuery(`
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
        }
        catch (err) {
            const error = err;
            if (error.code === "42P07" ||
                error.message?.includes("already exists") ||
                error.message?.includes("otp_verifications_pkey")) {
                await db_1.pool.runQuery(`
          create table if not exists otp_verifications (
            id uuid not null,
            user_id uuid not null references users(id) on delete cascade,
            phone text not null,
            verification_sid text,
            status text not null,
            verified_at timestamptz,
            created_at timestamptz not null default now()
          );
        `);
            }
            else {
                throw err;
            }
        }
    }
    const constraintResult = await db_1.pool.runQuery(`
      select 1
      from pg_constraint
      where conname = $1
    `, ["otp_verifications_status_check"]);
    if (constraintResult.rowCount === 0) {
        try {
            await db_1.pool.runQuery(`
        alter table otp_verifications
        add constraint otp_verifications_status_check
        check (status in ('pending','approved','expired'));
      `);
        }
        catch (err) {
            const error = err;
            if (error.code !== "42P07" &&
                !error.message?.includes("already exists") &&
                !error.message?.includes("does not exist")) {
                throw err;
            }
        }
    }
}
