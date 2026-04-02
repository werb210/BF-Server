import { randomUUID } from "crypto";
import { pool, runQuery } from "../../db";
import { type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { type Role } from "../../auth/roles";
import { AppError } from "../../middleware/errors";
import { normalizePhoneNumber } from "./phone";
import { logger } from "../../server/utils/logger";
import { config } from "../../config";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

async function runAuthQuery<T extends QueryResultRow = QueryResultRow>(
  runner: Queryable,
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  try {
    return await runner.query<T>(text, params);
  } catch (err: any) {
    if (config.env !== "test") {
      logger.error("auth_query_error", { error: err?.message ?? "unknown_error" });
    }
    throw err;
  }
}

export interface AuthUser {
  id: string;
  email: string | null;
  phoneNumber: string;
  phoneVerified: boolean;
  role: Role | null;
  silo: string | null;
  lenderId: string | null;
  status: string | null;
  active: boolean;
  isActive: boolean | null;
  disabled: boolean | null;
  lockedUntil: Date | null;
  tokenVersion: number;
}

function normalizePhoneInput(phoneNumber: string): string | null {
  return normalizePhoneNumber(phoneNumber);
}

function normalizePhoneColumnSql(column: string): string {
  const digits = `regexp_replace(${column}, '[^0-9]', '', 'g')`;
  return `case when length(${digits}) = 10 then '1' || ${digits} else ${digits} end`;
}

export async function findAuthUserByPhone(
  phoneNumber: string,
  client?: Queryable,
  options?: { forUpdate?: boolean }
): Promise<AuthUser | null> {
  const runner = client ?? pool;
  const forUpdate = options?.forUpdate ? " for update" : "";
  const normalizedPhone = normalizePhoneInput(phoneNumber);
  if (!normalizedPhone) {
    return null;
  }
  if (config.env === "test") {
    const res = await runAuthQuery<AuthUser>(
      runner,
      `select u.id,
              u.email,
              u.phone_number as "phoneNumber",
              u.phone_verified as "phoneVerified",
              u.role,
              u.silo,
              u.lender_id as "lenderId",
              coalesce(u.status, 'active') as status,
              u.active,
              u.is_active as "isActive",
              u.disabled,
              u.locked_until as "lockedUntil",
              u.token_version as "tokenVersion"
       from users u
       where u.phone_number = $1
          or u.phone = $1
       order by u.id asc${forUpdate}`,
      [normalizedPhone]
    );
    return res.rows[0] ?? null;
  }

  const normalizedDigits = normalizedPhone.replace(/\D/g, "");

  const selectSql = `select u.id,
            u.email,
            u.phone_number as "phoneNumber",
            u.phone_verified as "phoneVerified",
            u.role,
            u.silo,
            u.lender_id as "lenderId",
            coalesce(u.status, 'active') as status,
            u.active,
            u.is_active as "isActive",
            u.disabled,
            u.locked_until as "lockedUntil",
            u.token_version as "tokenVersion"
     from users u`;
  const orderSql = `order by u.id asc${forUpdate}`;

  const primaryRes = await runAuthQuery<AuthUser>(
    runner,
    `${selectSql}
     where ${normalizePhoneColumnSql("u.phone_number")} = $1
     ${orderSql}`,
    [normalizedDigits]
  );
  if (primaryRes.rows[0]) {
    return primaryRes.rows[0];
  }

  const secondaryRes = await runAuthQuery<AuthUser>(
    runner,
    `${selectSql}
     where ${normalizePhoneColumnSql("u.phone")} = $1
     ${orderSql}`,
    [normalizedDigits]
  );

  return secondaryRes.rows[0] ?? null;
}

export async function findAuthUserByEmail(
  email: string,
  client?: Queryable,
  options?: { forUpdate?: boolean }
): Promise<AuthUser | null> {
  const runner = client ?? pool;
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }
  const forUpdate = options?.forUpdate ? " for update" : "";
  const res = await runAuthQuery<AuthUser>(
    runner,
    `select u.id,
            u.email,
            u.phone_number as "phoneNumber",
            u.phone_verified as "phoneVerified",
            u.role,
            u.silo,
            u.lender_id as "lenderId",
            coalesce(u.status, 'active') as status,
            u.active,
            u.is_active as "isActive",
            u.disabled,
            u.locked_until as "lockedUntil",
            u.token_version as "tokenVersion"
     from users u
     where lower(u.email) = $1${forUpdate}`,
    [normalizedEmail]
  );
  return res.rows[0] ?? null;
}

export async function findAuthUserById(
  id: string,
  client?: Queryable
): Promise<AuthUser | null> {
  const runner = client ?? pool;

  const res = await runAuthQuery<AuthUser>(
    runner,
    `select u.id,
            u.email,
            u.phone_number as "phoneNumber",
            u.phone_verified as "phoneVerified",
            u.role,
            u.silo,
            u.lender_id as "lenderId",
            coalesce(u.status, 'active') as status,
            u.active,
            u.is_active as "isActive",
            u.disabled,
            u.locked_until as "lockedUntil",
            u.token_version as "tokenVersion"
     from users u
     where u.id = $1
     limit 1`,
    [id]
  );

  return res.rows[0] ?? null;
}

export async function createUser(params: {
  email?: string | null;
  phoneNumber: string;
  role: Role;
  lenderId?: string | null;
  active?: boolean;
  client?: Queryable;
}): Promise<AuthUser> {
  const runner = params.client ?? pool;
  const normalizedEmail = params.email ? params.email.trim().toLowerCase() : null;
  const resolvedEmail = normalizedEmail ?? null;
  const active = params.active ?? true;

  const res = await runAuthQuery<AuthUser>(
    runner,
    `insert into users (id, email, phone_number, role, lender_id, active)
     values ($1, $2, $3, $4, $5, $6)
     returning id,
              email,
              phone_number as "phoneNumber",
              phone_verified as "phoneVerified",
              role,
              silo,
              lender_id as "lenderId",
              status,
              active,
              is_active as "isActive",
              disabled,
              locked_until as "lockedUntil",
              token_version as "tokenVersion"`,
    [
      randomUUID(),
      resolvedEmail,
      params.phoneNumber,
      params.role,
      params.lenderId ?? null,
      active,
    ]
  );

  const created = res.rows[0];
  if (!created) {
    throw new AppError("data_error", "Failed to create user.", 500);
  }
  return created;
}

export async function updateUserPhoneNumber(params: {
  userId: string;
  phoneNumber: string;
  client?: Queryable;
}): Promise<AuthUser | null> {
  const runner = params.client ?? pool;
  const res = await runAuthQuery<AuthUser>(
    runner,
    `update users
     set phone_number = $1,
         phone = $1
     where id = $2
     returning id,
              email,
              phone_number as "phoneNumber",
              phone_verified as "phoneVerified",
              role,
              silo,
              lender_id as "lenderId",
              active,
              is_active as "isActive",
              disabled,
              locked_until as "lockedUntil",
              token_version as "tokenVersion"`,
    [params.phoneNumber, params.userId]
  );
  return res.rows[0] ?? null;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface OtpVerificationRecord {
  id: string;
  userId: string;
  phone: string;
  verificationSid: string | null;
  status: "pending" | "approved" | "expired";
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface OtpSessionRecord {
  id: string;
  phone: string;
  code: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface OtpCodeRecord {
  id: string;
  phone: string;
  code: string;
  createdAt: Date;
  expiresAt: Date;
}

export async function storeRefreshToken(params: {
  userId: string;
  token: string;
  tokenHash: string;
  expiresAt: Date;
  client?: Queryable;
}): Promise<void> {
  const runner = params.client ?? pool;
  await runAuthQuery(
    runner,
    `update auth_refresh_tokens
     set revoked_at = now()
     where user_id = $1
       and revoked_at is null`,
    [params.userId]
  );
  await runAuthQuery(
    runner,
    `insert into auth_refresh_tokens (id, user_id, token, token_hash, expires_at, revoked_at, created_at)
     values ($1, $2, $3, $4, $5, null, now())`,
    [randomUUID(), params.userId, params.token, params.tokenHash, params.expiresAt]
  );
}

export async function findValidRefreshToken(
  tokenHash: string,
  client?: Queryable
): Promise<RefreshTokenRecord | null> {
  const runner = client ?? pool;
  const res = await runAuthQuery<RefreshTokenRecord>(
    runner,
    `select id,
            user_id as "userId",
            token_hash as "tokenHash",
            expires_at as "expiresAt",
            revoked_at as "revokedAt",
            created_at as "createdAt"
     from auth_refresh_tokens
     where token_hash = $1
       and revoked_at is null
       and expires_at > now()
     limit 1`,
    [tokenHash]
  );
  return res.rows[0] ?? null;
}

export async function findRefreshTokenByHash(
  tokenHash: string,
  client?: Queryable
): Promise<RefreshTokenRecord | null> {
  const runner = client ?? pool;
  const res = await runAuthQuery<RefreshTokenRecord>(
    runner,
    `select id,
            user_id as "userId",
            token_hash as "tokenHash",
            expires_at as "expiresAt",
            revoked_at as "revokedAt",
            created_at as "createdAt"
     from auth_refresh_tokens
     where token_hash = $1
     limit 1`,
    [tokenHash]
  );
  return res.rows[0] ?? null;
}

export async function findActiveRefreshTokenForUser(
  userId: string,
  client?: Queryable
): Promise<{ token: string; expiresAt: Date } | null> {
  const runner = client ?? pool;
  const res = await runAuthQuery<{ token: string; expiresAt: Date }>(
    runner,
    `select token,
            expires_at as "expiresAt"
     from auth_refresh_tokens
     where user_id = $1
       and revoked_at is null
       and expires_at > now()
     order by created_at desc
     limit 1`,
    [userId]
  );
  return res.rows[0] ?? null;
}

export async function consumeRefreshToken(
  tokenHash: string,
  client?: Queryable
): Promise<RefreshTokenRecord | null> {
  const runner = client ?? pool;
  const res = await runAuthQuery<RefreshTokenRecord>(
    runner,
    `update auth_refresh_tokens
     set revoked_at = now()
     where token_hash = $1
       and revoked_at is null
       and expires_at > now()
     returning id,
              user_id as "userId",
              token_hash as "tokenHash",
              expires_at as "expiresAt",
              revoked_at as "revokedAt",
              created_at as "createdAt"`,
    [tokenHash]
  );
  return res.rows[0] ?? null;
}

export async function revokeRefreshToken(
  tokenHash: string,
  client?: Queryable
): Promise<void> {
  const runner = client ?? pool;
  await runAuthQuery(
    runner,
    `update auth_refresh_tokens
     set revoked_at = now()
     where token_hash = $1
       and revoked_at is null`,
    [tokenHash]
  );
}

export async function revokeRefreshTokensForUser(
  userId: string,
  client?: Queryable
): Promise<void> {
  const runner = client ?? pool;
  await runAuthQuery(
    runner,
    `update auth_refresh_tokens
     set revoked_at = now()
     where user_id = $1
       and revoked_at is null`,
    [userId]
  );
}

export async function incrementTokenVersion(
  userId: string,
  client?: Queryable
): Promise<void> {
  const runner = client ?? pool;
  await runAuthQuery(
    runner,
    `update users set token_version = token_version + 1 where id = $1`,
    [userId]
  );
}

export async function setPhoneVerified(
  userId: string,
  verified: boolean,
  client?: Queryable
): Promise<void> {
  const runner = client ?? pool;
  await runAuthQuery(
    runner,
    `update users set phone_verified = $1 where id = $2`,
    [verified, userId]
  );
}

export async function findApprovedOtpVerification(params: {
  userId: string;
  phone: string;
  client?: Queryable;
}): Promise<OtpVerificationRecord | null> {
  const runner = params.client ?? pool;
  const res = await runAuthQuery<OtpVerificationRecord>(
    runner,
    `select id,
            user_id as "userId",
            phone,
            verification_sid as "verificationSid",
            status,
            verified_at as "verifiedAt",
            created_at as "createdAt"
     from otp_verifications
     where user_id = $1
       and phone = $2
       and status = 'approved'
     order by verified_at desc nulls last, created_at desc
     limit 1`,
    [params.userId, params.phone]
  );
  return res.rows[0] ?? null;
}

export async function findApprovedOtpVerificationByPhone(params: {
  phone: string;
  client?: Queryable;
}): Promise<OtpVerificationRecord | null> {
  const runner = params.client ?? pool;
  const res = await runAuthQuery<OtpVerificationRecord>(
    runner,
    `select id,
            user_id as "userId",
            phone,
            verification_sid as "verificationSid",
            status,
            verified_at as "verifiedAt",
            created_at as "createdAt"
     from otp_verifications
     where phone = $1
       and status = 'approved'
     order by verified_at desc nulls last, created_at desc
     limit 1`,
    [params.phone]
  );
  return res.rows[0] ?? null;
}

export async function findLatestOtpVerificationByPhone(params: {
  phone: string;
  client?: Queryable;
}): Promise<OtpVerificationRecord | null> {
  const runner = params.client ?? pool;
  const res = await runAuthQuery<OtpVerificationRecord>(
    runner,
    `select id,
            user_id as "userId",
            phone,
            verification_sid as "verificationSid",
            status,
            verified_at as "verifiedAt",
            created_at as "createdAt"
     from otp_verifications
     where phone = $1
     order by created_at desc
     limit 1`,
    [params.phone]
  );
  return res.rows[0] ?? null;
}

export async function createOtpSession(params: {
  phone: string;
  code: string;
  expiresAt: Date;
  client?: Queryable;
}): Promise<OtpSessionRecord> {
  const runner = params.client ?? pool;
  const res = await runAuthQuery<OtpSessionRecord>(
    runner,
    `insert into otp_sessions (id, phone, code, created_at, expires_at)
     values ($1, $2, $3, now(), $4)
     returning id,
              phone,
              code,
              created_at as "createdAt",
              expires_at as "expiresAt"`,
    [randomUUID(), params.phone, params.code, params.expiresAt]
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError("data_error", "Failed to create OTP session.", 500);
  }

  return row;
}

export async function findLatestOtpSessionByPhone(params: {
  phone: string;
  client?: Queryable;
}): Promise<OtpSessionRecord | null> {
  const runner = params.client ?? pool;
  const res = await runAuthQuery<OtpSessionRecord>(
    runner,
    `select id,
            phone,
            code,
            created_at as "createdAt",
            expires_at as "expiresAt"
     from otp_sessions
     where phone = $1
     order by created_at desc
     limit 1`,
    [params.phone]
  );

  return res.rows[0] ?? null;
}

export async function createOtpCode(params: {
  phone: string;
  code: string;
  client?: Queryable;
}): Promise<OtpCodeRecord> {
  const runner = params.client ?? pool;
  const res = await runAuthQuery<OtpCodeRecord>(
    runner,
    `insert into otp_codes (id, phone, code, created_at, expires_at)
     values ($1, $2, $3, now(), now() + interval '5 minutes')
     returning id,
              phone,
              code,
              created_at as "createdAt",
              expires_at as "expiresAt"`,
    [randomUUID(), params.phone, params.code]
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError("data_error", "Failed to create OTP code.", 500);
  }

  return row;
}

export async function findLatestOtpCodeByPhone(params: {
  phone: string;
  client?: Queryable;
}): Promise<OtpCodeRecord | null> {
  const runner = params.client ?? pool;
  const res = await runAuthQuery<OtpCodeRecord>(
    runner,
    `select id,
            phone,
            code,
            created_at as "createdAt",
            expires_at as "expiresAt"
     from otp_codes
     where phone = $1
     order by created_at desc
     limit 1`,
    [params.phone]
  );
  return res.rows[0] ?? null;
}

export async function deleteOtpCodesByPhone(params: {
  phone: string;
  client?: Queryable;
}): Promise<void> {
  const runner = params.client ?? pool;
  await runAuthQuery(
    runner,
    `delete from otp_codes where phone = $1`,
    [params.phone]
  );
}

export async function createOtpVerification(params: {
  userId: string;
  phone: string;
  verificationSid?: string | null;
  status: "pending" | "approved" | "expired";
  verifiedAt?: Date | null;
  client?: Queryable;
}): Promise<void> {
  const runner = params.client ?? pool;
  await runAuthQuery(
    runner,
    `insert into otp_verifications (id, user_id, phone, verification_sid, status, verified_at, created_at)
     values ($1, $2, $3, $4, $5, $6, now())`,
    [
      randomUUID(),
      params.userId,
      params.phone,
      params.verificationSid ?? null,
      params.status,
      params.verifiedAt ?? null,
    ]
  );
}

export async function updateOtpVerificationStatus(params: {
  id: string;
  status: "pending" | "approved" | "expired";
  verifiedAt?: Date | null;
  client?: Queryable;
}): Promise<OtpVerificationRecord | null> {
  const runner = params.client ?? pool;
  const res = await runAuthQuery<OtpVerificationRecord>(
    runner,
    `update otp_verifications
     set status = $1,
         verified_at = $2
     where id = $3
     returning id,
              user_id as "userId",
              phone,
              verification_sid as "verificationSid",
              status,
              verified_at as "verifiedAt",
              created_at as "createdAt"`,
    [params.status, params.verifiedAt ?? null, params.id]
  );
  return res.rows[0] ?? null;
}

export async function expireOtpVerificationsForUser(
  userId: string,
  client?: Queryable
): Promise<void> {
  const runner = client ?? pool;
  await runAuthQuery(
    runner,
    `update otp_verifications
     set status = 'expired'
     where user_id = $1
       and status = 'approved'`,
    [userId]
  );
}

export async function setUserActive(
  userId: string,
  active: boolean,
  client?: Queryable
): Promise<void> {
  const runner = client ?? pool;
  await runAuthQuery(
    runner,
    `update users
     set active = $1,
         is_active = $1,
         disabled = $2,
         status = $3
     where id = $4`,
    [active, !active, active ? "ACTIVE" : "INACTIVE", userId]
  );
}

export async function updateUserRoleById(
  userId: string,
  role: Role,
  client?: Queryable
): Promise<void> {
  const runner = client ?? pool;
  await runAuthQuery(
    runner,
    `update users set role = $1 where id = $2`,
    [role, userId]
  );
}
