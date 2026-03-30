"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findAuthUserByPhone = findAuthUserByPhone;
exports.findAuthUserByEmail = findAuthUserByEmail;
exports.findAuthUserById = findAuthUserById;
exports.createUser = createUser;
exports.updateUserPhoneNumber = updateUserPhoneNumber;
exports.storeRefreshToken = storeRefreshToken;
exports.findValidRefreshToken = findValidRefreshToken;
exports.findRefreshTokenByHash = findRefreshTokenByHash;
exports.findActiveRefreshTokenForUser = findActiveRefreshTokenForUser;
exports.consumeRefreshToken = consumeRefreshToken;
exports.revokeRefreshToken = revokeRefreshToken;
exports.revokeRefreshTokensForUser = revokeRefreshTokensForUser;
exports.incrementTokenVersion = incrementTokenVersion;
exports.setPhoneVerified = setPhoneVerified;
exports.findApprovedOtpVerification = findApprovedOtpVerification;
exports.findApprovedOtpVerificationByPhone = findApprovedOtpVerificationByPhone;
exports.findLatestOtpVerificationByPhone = findLatestOtpVerificationByPhone;
exports.createOtpSession = createOtpSession;
exports.findLatestOtpSessionByPhone = findLatestOtpSessionByPhone;
exports.createOtpCode = createOtpCode;
exports.findLatestOtpCodeByPhone = findLatestOtpCodeByPhone;
exports.deleteOtpCodesByPhone = deleteOtpCodesByPhone;
exports.createOtpVerification = createOtpVerification;
exports.updateOtpVerificationStatus = updateOtpVerificationStatus;
exports.expireOtpVerificationsForUser = expireOtpVerificationsForUser;
exports.setUserActive = setUserActive;
exports.updateUserRoleById = updateUserRoleById;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const errors_1 = require("../../middleware/errors");
const phone_1 = require("./phone");
const logger_1 = require("../../server/utils/logger");
const config_1 = require("../../config");
async function runAuthQuery(runner, text, params) {
    try {
        return await runner.query(text, params);
    }
    catch (err) {
        if (config_1.config.env !== "test") {
            logger_1.logger.error("auth_query_error", { error: err?.message ?? "unknown_error" });
        }
        throw err;
    }
}
function normalizePhoneInput(phoneNumber) {
    return (0, phone_1.normalizePhoneNumber)(phoneNumber);
}
function normalizePhoneColumnSql(column) {
    const digits = `regexp_replace(${column}, '[^0-9]', '', 'g')`;
    return `case when length(${digits}) = 10 then '1' || ${digits} else ${digits} end`;
}
async function findAuthUserByPhone(phoneNumber, client, options) {
    const runner = client ?? db_1.pool;
    const forUpdate = options?.forUpdate ? " for update" : "";
    const normalizedPhone = normalizePhoneInput(phoneNumber);
    if (!normalizedPhone) {
        return null;
    }
    if (config_1.config.env === "test") {
        const res = await runAuthQuery(runner, `select u.id,
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
       order by u.id asc${forUpdate}`, [normalizedPhone]);
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
    const primaryRes = await runAuthQuery(runner, `${selectSql}
     where ${normalizePhoneColumnSql("u.phone_number")} = $1
     ${orderSql}`, [normalizedDigits]);
    if (primaryRes.rows[0]) {
        return primaryRes.rows[0];
    }
    const fallbackRes = await runAuthQuery(runner, `${selectSql}
     where ${normalizePhoneColumnSql("u.phone")} = $1
     ${orderSql}`, [normalizedDigits]);
    return fallbackRes.rows[0] ?? null;
}
async function findAuthUserByEmail(email, client, options) {
    const runner = client ?? db_1.pool;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
        return null;
    }
    const forUpdate = options?.forUpdate ? " for update" : "";
    const res = await runAuthQuery(runner, `select u.id,
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
     where lower(u.email) = $1${forUpdate}`, [normalizedEmail]);
    return res.rows[0] ?? null;
}
async function findAuthUserById(id, client) {
    const runner = client ?? db_1.pool;
    const res = await runAuthQuery(runner, `select u.id,
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
     limit 1`, [id]);
    return res.rows[0] ?? null;
}
async function createUser(params) {
    const runner = params.client ?? db_1.pool;
    const normalizedEmail = params.email ? params.email.trim().toLowerCase() : null;
    const resolvedEmail = normalizedEmail ?? null;
    const active = params.active ?? true;
    const res = await runAuthQuery(runner, `insert into users (id, email, phone_number, role, lender_id, active)
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
              token_version as "tokenVersion"`, [
        (0, crypto_1.randomUUID)(),
        resolvedEmail,
        params.phoneNumber,
        params.role,
        params.lenderId ?? null,
        active,
    ]);
    const created = res.rows[0];
    if (!created) {
        throw new errors_1.AppError("data_error", "Failed to create user.", 500);
    }
    return created;
}
async function updateUserPhoneNumber(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runAuthQuery(runner, `update users
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
              token_version as "tokenVersion"`, [params.phoneNumber, params.userId]);
    return res.rows[0] ?? null;
}
async function storeRefreshToken(params) {
    const runner = params.client ?? db_1.pool;
    await runAuthQuery(runner, `update auth_refresh_tokens
     set revoked_at = now()
     where user_id = $1
       and revoked_at is null`, [params.userId]);
    await runAuthQuery(runner, `insert into auth_refresh_tokens (id, user_id, token, token_hash, expires_at, revoked_at, created_at)
     values ($1, $2, $3, $4, $5, null, now())`, [(0, crypto_1.randomUUID)(), params.userId, params.token, params.tokenHash, params.expiresAt]);
}
async function findValidRefreshToken(tokenHash, client) {
    const runner = client ?? db_1.pool;
    const res = await runAuthQuery(runner, `select id,
            user_id as "userId",
            token_hash as "tokenHash",
            expires_at as "expiresAt",
            revoked_at as "revokedAt",
            created_at as "createdAt"
     from auth_refresh_tokens
     where token_hash = $1
       and revoked_at is null
       and expires_at > now()
     limit 1`, [tokenHash]);
    return res.rows[0] ?? null;
}
async function findRefreshTokenByHash(tokenHash, client) {
    const runner = client ?? db_1.pool;
    const res = await runAuthQuery(runner, `select id,
            user_id as "userId",
            token_hash as "tokenHash",
            expires_at as "expiresAt",
            revoked_at as "revokedAt",
            created_at as "createdAt"
     from auth_refresh_tokens
     where token_hash = $1
     limit 1`, [tokenHash]);
    return res.rows[0] ?? null;
}
async function findActiveRefreshTokenForUser(userId, client) {
    const runner = client ?? db_1.pool;
    const res = await runAuthQuery(runner, `select token,
            expires_at as "expiresAt"
     from auth_refresh_tokens
     where user_id = $1
       and revoked_at is null
       and expires_at > now()
     order by created_at desc
     limit 1`, [userId]);
    return res.rows[0] ?? null;
}
async function consumeRefreshToken(tokenHash, client) {
    const runner = client ?? db_1.pool;
    const res = await runAuthQuery(runner, `update auth_refresh_tokens
     set revoked_at = now()
     where token_hash = $1
       and revoked_at is null
       and expires_at > now()
     returning id,
              user_id as "userId",
              token_hash as "tokenHash",
              expires_at as "expiresAt",
              revoked_at as "revokedAt",
              created_at as "createdAt"`, [tokenHash]);
    return res.rows[0] ?? null;
}
async function revokeRefreshToken(tokenHash, client) {
    const runner = client ?? db_1.pool;
    await runAuthQuery(runner, `update auth_refresh_tokens
     set revoked_at = now()
     where token_hash = $1
       and revoked_at is null`, [tokenHash]);
}
async function revokeRefreshTokensForUser(userId, client) {
    const runner = client ?? db_1.pool;
    await runAuthQuery(runner, `update auth_refresh_tokens
     set revoked_at = now()
     where user_id = $1
       and revoked_at is null`, [userId]);
}
async function incrementTokenVersion(userId, client) {
    const runner = client ?? db_1.pool;
    await runAuthQuery(runner, `update users set token_version = token_version + 1 where id = $1`, [userId]);
}
async function setPhoneVerified(userId, verified, client) {
    const runner = client ?? db_1.pool;
    await runAuthQuery(runner, `update users set phone_verified = $1 where id = $2`, [verified, userId]);
}
async function findApprovedOtpVerification(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runAuthQuery(runner, `select id,
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
     limit 1`, [params.userId, params.phone]);
    return res.rows[0] ?? null;
}
async function findApprovedOtpVerificationByPhone(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runAuthQuery(runner, `select id,
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
     limit 1`, [params.phone]);
    return res.rows[0] ?? null;
}
async function findLatestOtpVerificationByPhone(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runAuthQuery(runner, `select id,
            user_id as "userId",
            phone,
            verification_sid as "verificationSid",
            status,
            verified_at as "verifiedAt",
            created_at as "createdAt"
     from otp_verifications
     where phone = $1
     order by created_at desc
     limit 1`, [params.phone]);
    return res.rows[0] ?? null;
}
async function createOtpSession(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runAuthQuery(runner, `insert into otp_sessions (id, phone, code, created_at, expires_at)
     values ($1, $2, $3, now(), $4)
     returning id,
              phone,
              code,
              created_at as "createdAt",
              expires_at as "expiresAt"`, [(0, crypto_1.randomUUID)(), params.phone, params.code, params.expiresAt]);
    const row = res.rows[0];
    if (!row) {
        throw new errors_1.AppError("data_error", "Failed to create OTP session.", 500);
    }
    return row;
}
async function findLatestOtpSessionByPhone(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runAuthQuery(runner, `select id,
            phone,
            code,
            created_at as "createdAt",
            expires_at as "expiresAt"
     from otp_sessions
     where phone = $1
     order by created_at desc
     limit 1`, [params.phone]);
    return res.rows[0] ?? null;
}
async function createOtpCode(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runAuthQuery(runner, `insert into otp_codes (id, phone, code, created_at, expires_at)
     values ($1, $2, $3, now(), now() + interval '5 minutes')
     returning id,
              phone,
              code,
              created_at as "createdAt",
              expires_at as "expiresAt"`, [(0, crypto_1.randomUUID)(), params.phone, params.code]);
    const row = res.rows[0];
    if (!row) {
        throw new errors_1.AppError("data_error", "Failed to create OTP code.", 500);
    }
    return row;
}
async function findLatestOtpCodeByPhone(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runAuthQuery(runner, `select id,
            phone,
            code,
            created_at as "createdAt",
            expires_at as "expiresAt"
     from otp_codes
     where phone = $1
     order by created_at desc
     limit 1`, [params.phone]);
    return res.rows[0] ?? null;
}
async function deleteOtpCodesByPhone(params) {
    const runner = params.client ?? db_1.pool;
    await runAuthQuery(runner, `delete from otp_codes where phone = $1`, [params.phone]);
}
async function createOtpVerification(params) {
    const runner = params.client ?? db_1.pool;
    await runAuthQuery(runner, `insert into otp_verifications (id, user_id, phone, verification_sid, status, verified_at, created_at)
     values ($1, $2, $3, $4, $5, $6, now())`, [
        (0, crypto_1.randomUUID)(),
        params.userId,
        params.phone,
        params.verificationSid ?? null,
        params.status,
        params.verifiedAt ?? null,
    ]);
}
async function updateOtpVerificationStatus(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runAuthQuery(runner, `update otp_verifications
     set status = $1,
         verified_at = $2
     where id = $3
     returning id,
              user_id as "userId",
              phone,
              verification_sid as "verificationSid",
              status,
              verified_at as "verifiedAt",
              created_at as "createdAt"`, [params.status, params.verifiedAt ?? null, params.id]);
    return res.rows[0] ?? null;
}
async function expireOtpVerificationsForUser(userId, client) {
    const runner = client ?? db_1.pool;
    await runAuthQuery(runner, `update otp_verifications
     set status = 'expired'
     where user_id = $1
       and status = 'approved'`, [userId]);
}
async function setUserActive(userId, active, client) {
    const runner = client ?? db_1.pool;
    await runAuthQuery(runner, `update users
     set active = $1,
         is_active = $1,
         disabled = $2,
         status = $3
     where id = $4`, [active, !active, active ? "ACTIVE" : "INACTIVE", userId]);
}
async function updateUserRoleById(userId, role, client) {
    const runner = client ?? db_1.pool;
    await runAuthQuery(runner, `update users set role = $1 where id = $2`, [role, userId]);
}
