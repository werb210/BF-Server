"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueAccessToken = issueAccessToken;
exports.issueRefreshToken = issueRefreshToken;
exports.assertUserActive = assertUserActive;
exports.assertAuthSubsystem = assertAuthSubsystem;
exports.startOtp = startOtp;
exports.verifyOtpCode = verifyOtpCode;
exports.refreshSession = refreshSession;
exports.createUserAccount = createUserAccount;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = require("crypto");
const auth_repo_1 = require("./auth.repo");
const errors_1 = require("../../middleware/errors");
const audit_service_1 = require("../audit/audit.service");
const db_1 = require("../../db");
const roles_1 = require("../../auth/roles");
const logger_1 = require("../../observability/logger");
const requestContext_1 = require("../../middleware/requestContext");
const phone_1 = require("./phone");
const ensureOtpTable_1 = require("../../db/ensureOtpTable");
const config_1 = require("../../config");
const jwt_1 = require("../../auth/jwt");
const silo_1 = require("../../auth/silo");
const tokenUtils_1 = require("../../auth/tokenUtils");
const capabilities_1 = require("../../auth/capabilities");
const twilio_1 = require("../../services/twilio");
const lenderBinding_1 = require("../../auth/lenderBinding");
const OTP_TRACE = (...args) => {
    console.log("[OTP_TRACE]", ...args);
};
const OTP_SESSION_TTL_MS = 10 * 60 * 1000;
const refreshReplayGuard = new Map();
const MAX_RUNTIME_AUTH_ENTRIES = 1000;
function trimMapSize(map, max = MAX_RUNTIME_AUTH_ENTRIES) {
    if (map.size > max) {
        const firstKey = map.keys().next().value;
        if (firstKey) {
            map.delete(firstKey);
        }
    }
}
function registerRefreshReplay(tokenHash, windowMs) {
    if (refreshReplayGuard.has(tokenHash)) {
        return false;
    }
    const timeout = setTimeout(() => refreshReplayGuard.delete(tokenHash), windowMs);
    timeout.unref();
    refreshReplayGuard.set(tokenHash, timeout);
    trimMapSize(refreshReplayGuard);
    return true;
}
function assertE164(phone) {
    const normalized = (0, phone_1.normalizeOtpPhone)(phone);
    if (!normalized) {
        throw new Error("Phone number must be in E.164 format");
    }
    return normalized;
}
function issueAccessToken(payload) {
    try {
        return (0, jwt_1.signAccessToken)(payload);
    }
    catch (err) {
        throw new errors_1.AppError("auth_misconfigured", "Auth is not configured.", 500);
    }
}
function issueRefreshToken(params) {
    const secret = config_1.config.auth.refreshSecret;
    if (!secret) {
        throw new errors_1.AppError("auth_misconfigured", "Auth is not configured.", 500);
    }
    const payload = {
        sub: params.userId,
        tokenVersion: params.tokenVersion,
        type: "refresh",
        jti: (0, crypto_1.randomUUID)(),
    };
    const expiresIn = config_1.config.auth.refreshExpiresMs;
    const options = {
        algorithm: "HS256",
    };
    if (expiresIn !== undefined) {
        options.expiresIn = expiresIn;
    }
    const token = jsonwebtoken_1.default.sign(payload, secret, options);
    return {
        token,
        tokenHash: (0, tokenUtils_1.hashRefreshToken)(token),
        expiresAt: new Date(Date.now() + config_1.config.auth.refreshExpiresMs),
    };
}
function verifyRefreshToken(token) {
    const secret = config_1.config.auth.refreshSecret;
    if (!secret) {
        throw new errors_1.AppError("auth_misconfigured", "Auth is not configured.", 500);
    }
    try {
        return jsonwebtoken_1.default.verify(token, secret, {
            algorithms: ["HS256"],
            clockTolerance: config_1.config.auth.jwtClockSkewSeconds,
        });
    }
    catch {
        throw new errors_1.AppError("invalid_refresh_token", "Invalid refresh token.", 401);
    }
}
function resolveRefreshPayload(payload) {
    const userId = typeof payload.sub === "string" ? payload.sub : null;
    const tokenVersion = typeof payload.tokenVersion === "number" ? payload.tokenVersion : null;
    const type = payload.type;
    if (!userId || tokenVersion === null || type !== "refresh") {
        throw new errors_1.AppError("invalid_refresh_token", "Invalid refresh token.", 401);
    }
    return { userId, tokenVersion };
}
function resolveAuthRole(role) {
    if (role && (0, roles_1.isRole)(role)) {
        return role;
    }
    throw (0, errors_1.forbiddenError)("User has no assigned role");
}
function resolveAuthSilo(silo) {
    if (typeof silo === "string" && silo.trim().length > 0) {
        return silo.trim();
    }
    return silo_1.DEFAULT_AUTH_SILO;
}
function assertUserActive(params) {
    const { user, requestId, phoneTail } = params;
    if (user.disabled === true) {
        throw new errors_1.AppError("account_disabled", "Account is disabled.", 403);
    }
    if (user.isActive === false) {
        (0, logger_1.logInfo)("otp_verify_inactive_user", {
            userId: user.id,
            phoneTail,
            requestId,
        });
        throw new errors_1.AppError("user_disabled", "Account is inactive.", 403);
    }
    const isActive = user.active === true || user.isActive === true;
    if (!isActive) {
        (0, logger_1.logInfo)("otp_verify_inactive_user", {
            userId: user.id,
            phoneTail,
            requestId,
        });
        throw new errors_1.AppError("user_disabled", "Account is inactive.", 403);
    }
    const isLocked = user.lockedUntil && user.lockedUntil.getTime() > Date.now();
    if (isLocked) {
        throw new errors_1.AppError("locked", "Account is locked.", 403);
    }
}
function assertAuthSubsystem() {
    const accessSecret = config_1.config.auth.jwtSecret;
    const refreshSecret = config_1.config.auth.refreshSecret;
    if (!accessSecret || !refreshSecret) {
        throw new errors_1.AppError("auth_misconfigured", "Auth is not configured.", 500);
    }
}
const OTP_VERIFY_DEDUP_WINDOW_MS = 1500;
const otpVerifyInFlight = new Map();
const OTP_VERIFICATION_MAX_AGE_MS = 10 * 60 * 1000;
const OTP_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const otpAttemptState = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [phone, state] of otpAttemptState.entries()) {
        if (state.resetAt <= now) {
            otpAttemptState.delete(phone);
        }
    }
}, 60000).unref();
function ensureTestOtp(phoneE164) {
    const forcedTestOtp = config_1.config.auth.testOtpCode?.trim();
    if (forcedTestOtp) {
        return forcedTestOtp;
    }
    const seed = `${phoneE164}:${Math.floor(Date.now() / (5 * 60 * 1000))}`;
    return (parseInt((0, crypto_1.createHash)("sha256").update(seed).digest("hex").slice(0, 8), 16) % 900000 + 100000).toString();
}
function hashOtpCode(code) {
    const salt = config_1.config.auth.otpHashSalt?.trim() || config_1.config.twilio.authToken?.trim() || "staff-server-otp";
    return (0, crypto_1.createHash)("sha256").update(`${salt}:${code}`).digest("hex");
}
function assertOtpAttemptLimit(phoneE164) {
    const current = otpAttemptState.get(phoneE164);
    const now = Date.now();
    if (!current || current.resetAt <= now) {
        return;
    }
    if (current.count >= OTP_MAX_VERIFY_ATTEMPTS) {
        throw new errors_1.AppError("too_many_attempts", "Too many OTP attempts. Please request a new code.", 429);
    }
}
function recordOtpAttempt(phoneE164, codeHash) {
    const now = Date.now();
    const current = otpAttemptState.get(phoneE164);
    if (!current || current.resetAt <= now) {
        otpAttemptState.set(phoneE164, { count: 1, resetAt: now + OTP_ATTEMPT_WINDOW_MS, lastCodeHash: codeHash });
        trimMapSize(otpAttemptState);
        return;
    }
    current.count += 1;
    current.lastCodeHash = codeHash;
}
function clearOtpAttemptLimit(phoneE164) {
    otpAttemptState.delete(phoneE164);
}
function assertSingleVerifyAttempt(phoneE164) {
    if (config_1.config.env === "test") {
        return;
    }
    if (otpVerifyInFlight.has(phoneE164)) {
        throw new errors_1.AppError("otp_verify_in_progress", "OTP verification already in progress.", 429);
    }
    const timeout = setTimeout(() => {
        otpVerifyInFlight.delete(phoneE164);
    }, OTP_VERIFY_DEDUP_WINDOW_MS);
    timeout.unref();
    otpVerifyInFlight.set(phoneE164, timeout);
    trimMapSize(otpVerifyInFlight);
}
function clearVerifyAttempt(phoneE164) {
    const timeout = otpVerifyInFlight.get(phoneE164);
    if (timeout) {
        clearTimeout(timeout);
        otpVerifyInFlight.delete(phoneE164);
    }
}
function fetchTwilioErrorDetails(error) {
    if (error && typeof error === "object") {
        const err = error;
        const details = {
            message: typeof err.message === "string"
                ? err.message
                : "Twilio verification failed",
        };
        if (typeof err.code === "number" || typeof err.code === "string") {
            details.code = err.code;
        }
        if (typeof err.status === "number") {
            details.status = err.status;
        }
        return details;
    }
    if (error instanceof Error) {
        return { message: error.message };
    }
    return { message: "Twilio verification failed" };
}
function isTwilioAuthError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 20003);
}
function isTwilioUnavailableError(error) {
    if (!error || typeof error !== "object") {
        return false;
    }
    const code = error.code;
    if (typeof code === "string") {
        return ["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(code);
    }
    return false;
}
function attachTwilioDetails(error, details) {
    const twilioCode = typeof details.code === "number" || typeof details.code === "string"
        ? details.code
        : undefined;
    const twilioMessage = details.message;
    error.details = {
        twilioCode,
        twilioMessage,
    };
    return error;
}
function mapTwilioVerifyError(details, err) {
    if (isTwilioAuthError(err)) {
        return attachTwilioDetails(new errors_1.AppError("twilio_auth_failed", "Twilio authentication failed.", 500), details);
    }
    const codeValue = typeof details.code === "string" ? Number(details.code) : details.code;
    if (codeValue === 60203) {
        return attachTwilioDetails(new errors_1.AppError("too_many_attempts", details.message, 429), details);
    }
    if (codeValue === 60202) {
        return attachTwilioDetails(new errors_1.AppError("expired_code", details.message, 410), details);
    }
    if (codeValue === 60200 || codeValue === 20404 || details.status === 404) {
        return attachTwilioDetails(new errors_1.AppError("invalid_code", details.message, 400), details);
    }
    if (details.status && details.status >= 500) {
        return attachTwilioDetails(new errors_1.AppError("twilio_error", details.message, 500), details);
    }
    if (isTwilioUnavailableError(err)) {
        return attachTwilioDetails(new errors_1.AppError("twilio_error", details.message, 500), details);
    }
    return attachTwilioDetails(new errors_1.AppError("twilio_error", details.message, 500), details);
}
function mapTwilioVerifyCheckFailure(details, err) {
    if (isTwilioAuthError(err)) {
        return {
            ok: false,
            status: 500,
            error: {
                code: "twilio_error",
                message: "Twilio authentication failed.",
            },
        };
    }
    const codeValue = typeof details.code === "string" ? Number(details.code) : details.code;
    if (codeValue === 60203) {
        return {
            ok: false,
            status: 429,
            error: { code: "too_many_attempts", message: details.message },
        };
    }
    if (codeValue === 60202) {
        return {
            ok: false,
            status: 400,
            error: { code: "expired_code", message: details.message },
        };
    }
    if (codeValue === 60200 || codeValue === 20404 || details.status === 404) {
        return {
            ok: false,
            status: 400,
            error: { code: "invalid_code", message: details.message },
        };
    }
    if (details.status && details.status >= 500) {
        return {
            ok: false,
            status: 500,
            error: { code: "twilio_error", message: details.message },
        };
    }
    if (isTwilioUnavailableError(err)) {
        return {
            ok: false,
            status: 500,
            error: { code: "twilio_error", message: details.message },
        };
    }
    return {
        ok: false,
        status: 500,
        error: { code: "twilio_error", message: details.message },
    };
}
function fetchPhoneTail(phoneE164) {
    return phoneE164.slice(-2);
}
function isOtpVerificationFresh(record) {
    const timestamp = record.verifiedAt ?? record.createdAt;
    return Date.now() - timestamp.valueOf() <= OTP_VERIFICATION_MAX_AGE_MS;
}
function isOtpSessionExpired(record) {
    return record.expiresAt.valueOf() <= Date.now();
}
function isMissingOtpTableError(error) {
    if (!(typeof error === "object" && error !== null)) {
        return false;
    }
    const typedError = error;
    return (typedError.code === "42P01" ||
        typedError.message?.includes("relation \"otp_verifications\" does not exist") === true ||
        typedError.message?.includes("relation \"otp_sessions\" does not exist") === true);
}
async function safeFindLatestOtpVerificationByPhone(phone, requestId) {
    try {
        return await (0, auth_repo_1.findLatestOtpVerificationByPhone)({ phone });
    }
    catch (err) {
        if (isMissingOtpTableError(err)) {
            (0, logger_1.logWarn)("otp_verification_table_missing", { requestId });
            return null;
        }
        throw err;
    }
}
async function safeFindLatestOtpSessionByPhone(phone, requestId) {
    try {
        return await (0, auth_repo_1.findLatestOtpSessionByPhone)({ phone });
    }
    catch (err) {
        if (isMissingOtpTableError(err)) {
            (0, logger_1.logWarn)("otp_session_table_missing", { requestId });
            return null;
        }
        throw err;
    }
}
async function safeCreateOtpVerification(params) {
    try {
        await (0, auth_repo_1.createOtpVerification)({
            userId: params.userId,
            phone: params.phone,
            verificationSid: params.verificationSid ?? null,
            status: params.status,
            verifiedAt: params.verifiedAt ?? null,
            ...(params.client ? { client: params.client } : {}),
        });
    }
    catch (err) {
        if (isMissingOtpTableError(err)) {
            (0, logger_1.logWarn)("otp_verification_table_missing", { requestId: params.requestId });
            return;
        }
        throw err;
    }
}
async function safeUpdateOtpVerificationStatus(params) {
    try {
        await (0, auth_repo_1.updateOtpVerificationStatus)({
            id: params.id,
            status: params.status,
            verifiedAt: params.verifiedAt ?? null,
            ...(params.client ? { client: params.client } : {}),
        });
    }
    catch (err) {
        if (isMissingOtpTableError(err)) {
            (0, logger_1.logWarn)("otp_verification_table_missing", { requestId: params.requestId });
            return;
        }
        throw err;
    }
}
function resolveOtpFailure(status) {
    if (status === "canceled" || status === "expired") {
        return {
            ok: false,
            status: 400,
            error: { code: "expired_code", message: "OTP code expired." },
        };
    }
    if (typeof status === "string" && status.length > 0) {
        return {
            ok: false,
            status: 400,
            error: { code: "otp_failed", message: "OTP verification failed." },
        };
    }
    return {
        ok: false,
        status: 400,
        error: { code: "invalid_code", message: "Invalid or expired code" },
    };
}
function shouldLogFullOtpPhone() {
    return config_1.config.env !== "production" || config_1.config.auth.debugOtpPhone === "1";
}
function otpLogMeta(requestId, phoneE164) {
    return {
        requestId,
        phoneTail: fetchPhoneTail(phoneE164),
        ...(shouldLogFullOtpPhone() ? { normalizedPhone: phoneE164 } : {}),
    };
}
function generatePlaceholderPhoneNumber() {
    const raw = (0, crypto_1.randomUUID)().replace(/-/g, "");
    const digits = raw.replace(/[a-f]/gi, (value) => (parseInt(value, 16) % 10).toString());
    const suffix = digits.slice(0, 10);
    return `+1999${suffix}`;
}
async function createVerification(params) {
    const service = params.twilioClient.verify.v2.services(params.serviceSid);
    if (!service.verifications || typeof service.verifications.create !== "function") {
        throw new errors_1.AppError("twilio_error", "Twilio verifications client is unavailable.", 500);
    }
    return service.verifications.create({ to: params.to, channel: "sms" });
}
async function createVerificationCheck(params) {
    const service = params.twilioClient.verify.v2.services(params.serviceSid);
    if (!service.verificationChecks || typeof service.verificationChecks.create !== "function") {
        throw new errors_1.AppError("twilio_error", "Twilio verificationChecks client is unavailable.", 500);
    }
    return service.verificationChecks.create({ to: params.to, code: params.code });
}
async function startOtp(phone) {
    const requestId = (0, requestContext_1.fetchRequestId)() ?? "unknown";
    try {
        try {
            await (0, ensureOtpTable_1.ensureOtpTableExists)();
        }
        catch (err) {
            (0, logger_1.logError)("otp_schema_self_heal_failed", { err, requestId });
        }
        let phoneE164;
        try {
            phoneE164 = assertE164(phone);
        }
        catch {
            const phoneTail = typeof phone === "string" ? fetchPhoneTail(phone.trim()) : "";
            (0, logger_1.logWarn)("otp_start_received", {
                requestId,
                phoneTail,
                ok: false,
                error: "invalid_phone",
            });
            throw new errors_1.AppError("invalid_phone", "Invalid phone number", 400);
        }
        const startMeta = otpLogMeta(requestId, phoneE164);
        (0, logger_1.logInfo)("otp_start_received", {
            ...startMeta,
            ok: true,
        });
        const twilioClient = (0, twilio_1.fetchTwilioClient)();
        const serviceSid = (0, twilio_1.fetchVerifyServiceSid)();
        clearOtpAttemptLimit(phoneE164);
        if (config_1.config.env === "test") {
            const generatedOtp = ensureTestOtp(phoneE164);
            await (0, auth_repo_1.createOtpCode)({
                phone: phoneE164,
                code: generatedOtp,
            });
            const session = await (0, auth_repo_1.createOtpSession)({
                phone: phoneE164,
                code: generatedOtp,
                expiresAt: new Date(Date.now() + OTP_SESSION_TTL_MS),
            });
            let sid = session.id;
            if (serviceSid) {
                try {
                    const verification = await createVerification({
                        twilioClient,
                        serviceSid,
                        to: phoneE164,
                    });
                    sid = verification.sid ?? sid;
                }
                catch {
                    // Do not fail test-mode OTP generation when provider mocks are unavailable.
                }
            }
            OTP_TRACE("OTP_START", {
                phone: phoneE164,
                code: generatedOtp,
                instance: process.pid,
                time: Date.now(),
            });
            (0, logger_1.logInfo)("otp_start_sent", {
                ...startMeta,
                providerStatus: "approved",
                sid,
            });
            return {
                ok: true,
                sid,
                otp: generatedOtp,
            };
        }
        try {
            const session = await (0, auth_repo_1.createOtpSession)({
                phone: phoneE164,
                code: "",
                expiresAt: new Date(Date.now() + OTP_SESSION_TTL_MS),
            });
            const verification = await createVerification({
                twilioClient,
                serviceSid,
                to: phoneE164,
            });
            (0, logger_1.logInfo)("otp_start_sent", {
                ...startMeta,
                serviceSid,
                verificationSid: verification.sid,
                providerStatus: verification.status,
            });
            try {
                const userRecord = await (0, auth_repo_1.findAuthUserByPhone)(phoneE164);
                if (userRecord) {
                    await safeCreateOtpVerification({
                        userId: userRecord.id,
                        phone: phoneE164,
                        verificationSid: verification.sid ?? null,
                        status: "pending",
                        requestId,
                    });
                }
            }
            catch (err) {
                (0, logger_1.logError)("otp_start_record_failed", {
                    requestId,
                    error: err instanceof Error ? err.message : "unknown_error",
                });
            }
            return { ok: true, sid: verification.sid ?? session.id };
        }
        catch (err) {
            const details = fetchTwilioErrorDetails(err);
            (0, logger_1.logError)("auth_twilio_verify_failed", {
                action: "otp_start",
                ...startMeta,
                serviceSid,
                twilioCode: details.code,
                status: details.status,
                message: details.message,
                error: err,
            });
            throw mapTwilioVerifyError(details, err);
        }
    }
    catch (err) {
        (0, logger_1.logError)("otp_start_failed", {
            requestId,
            error: err instanceof Error ? err.message : "unknown_error",
        });
        throw err;
    }
}
async function verifyOtpCode(params) {
    const requestId = (0, requestContext_1.fetchRequestId)() ?? "unknown";
    let dedupPhone = null;
    try {
        try {
            await (0, ensureOtpTable_1.ensureOtpTableExists)();
        }
        catch (err) {
            (0, logger_1.logError)("otp_schema_self_heal_failed", { err, requestId });
        }
        const code = params.code?.trim() ?? "";
        const phoneE164 = (0, phone_1.normalizeOtpPhone)(params.phone);
        if (!code || !phoneE164) {
            (0, logger_1.logWarn)("otp_verify_received", {
                requestId,
                phoneTail: typeof params.phone === "string" ? fetchPhoneTail(params.phone) : "",
                providerStatus: "not_checked",
                userFound: false,
                tokenCreated: false,
                ok: false,
                error: !phoneE164 ? "invalid_phone" : "invalid_request",
            });
            return {
                ok: false,
                status: 400,
                error: { code: !phoneE164 ? "invalid_phone" : "invalid_request", message: !phoneE164 ? "Invalid phone number" : "Phone and code are required" },
            };
        }
        const meta = otpLogMeta(requestId, phoneE164);
        (0, logger_1.logInfo)("otp_verify_received", {
            ...meta,
            providerStatus: "pending",
            userFound: false,
            tokenCreated: false,
            ok: null,
            error: null,
        });
        const codeHash = hashOtpCode(code);
        assertOtpAttemptLimit(phoneE164);
        assertSingleVerifyAttempt(phoneE164);
        dedupPhone = phoneE164;
        const latestSession = await safeFindLatestOtpSessionByPhone(phoneE164, requestId);
        if (!latestSession || isOtpSessionExpired(latestSession)) {
            (0, logger_1.logWarn)("otp_verify_response", {
                ...meta,
                providerStatus: "not_checked",
                userFound: false,
                tokenCreated: false,
                ok: false,
                error: "expired_code",
            });
            return { ok: false, status: 400, error: { code: "expired_code", message: "OTP session expired" } };
        }
        let latestVerification = await safeFindLatestOtpVerificationByPhone(phoneE164, requestId);
        if ((!latestVerification || !isOtpVerificationFresh(latestVerification)) && config_1.config.env !== "test") {
            (0, logger_1.logWarn)("otp_verify_response", {
                ...meta,
                providerStatus: "not_checked",
                userFound: false,
                tokenCreated: false,
                ok: false,
                error: "expired_code",
            });
            return { ok: false, status: 400, error: { code: "expired_code", message: "OTP session expired" } };
        }
        let providerStatus;
        if (latestVerification?.status === "approved" &&
            isOtpVerificationFresh(latestVerification)) {
            providerStatus = "approved";
        }
        const twilioClient = (0, twilio_1.fetchTwilioClient)();
        const serviceSid = (0, twilio_1.fetchVerifyServiceSid)();
        if (providerStatus !== "approved") {
            try {
                const check = await createVerificationCheck({
                    twilioClient,
                    serviceSid,
                    to: phoneE164,
                    code,
                });
                providerStatus = check.status;
                (0, logger_1.logInfo)("otp_verify_provider_result", {
                    ...meta,
                    providerStatus,
                    userFound: false,
                    tokenCreated: false,
                });
            }
            catch (err) {
                if (config_1.config.env === "test") {
                    providerStatus = undefined;
                }
                else {
                    const details = fetchTwilioErrorDetails(err);
                    (0, logger_1.logError)("auth_twilio_verify_failed", {
                        action: "otp_verify",
                        ...meta,
                        serviceSid,
                        twilioCode: details.code,
                        status: details.status,
                        message: details.message,
                        error: err,
                    });
                    recordOtpAttempt(phoneE164, codeHash);
                    const mapped = mapTwilioVerifyCheckFailure(details, err);
                    (0, logger_1.logWarn)("otp_verify_response", { ...meta, providerStatus: "provider_error", userFound: false, tokenCreated: false, ok: false, error: mapped.error.code });
                    return mapped;
                }
            }
            if (config_1.config.env === "test" && providerStatus !== "approved") {
                const otpRecord = await (0, auth_repo_1.findLatestOtpCodeByPhone)({ phone: phoneE164 });
                if (!otpRecord) {
                    recordOtpAttempt(phoneE164, codeHash);
                    (0, logger_1.logInfo)("otp_verify_provider_result", { ...meta, providerStatus: "missing", userFound: false, tokenCreated: false });
                    return { ok: false, status: 400, error: { code: "invalid_code", message: "No code" } };
                }
                if (otpRecord.expiresAt.getTime() <= Date.now()) {
                    recordOtpAttempt(phoneE164, codeHash);
                    (0, logger_1.logInfo)("otp_verify_provider_result", { ...meta, providerStatus: "expired", userFound: false, tokenCreated: false });
                    return { ok: false, status: 400, error: { code: "expired_code", message: "Expired" } };
                }
                if (otpRecord.code !== code) {
                    recordOtpAttempt(phoneE164, codeHash);
                    (0, logger_1.logInfo)("otp_verify_provider_result", { ...meta, providerStatus: "invalid", userFound: false, tokenCreated: false });
                    return { ok: false, status: 400, error: { code: "invalid_code", message: "Invalid" } };
                }
                providerStatus = "approved";
            }
        }
        if (providerStatus !== "approved") {
            recordOtpAttempt(phoneE164, codeHash);
            const failure = resolveOtpFailure(providerStatus);
            (0, logger_1.logWarn)("otp_verify_response", { ...meta, providerStatus, userFound: false, tokenCreated: false, ok: false, error: failure.error.code });
            return failure;
        }
        clearOtpAttemptLimit(phoneE164);
        await (0, auth_repo_1.deleteOtpCodesByPhone)({ phone: phoneE164 });
        const existingUser = await (0, auth_repo_1.findAuthUserByPhone)(phoneE164);
        (0, logger_1.logInfo)("otp_verify_user_lookup", { ...meta, providerStatus, userFound: Boolean(existingUser), tokenCreated: false });
        if (!existingUser) {
            (0, logger_1.logWarn)("otp_verify_response", { ...meta, providerStatus, userFound: false, tokenCreated: false, ok: false, error: "user_not_found" });
            return { ok: false, status: 404, error: { code: "user_not_found", message: "User not found" } };
        }
        const dbClient = await db_1.pool.connect();
        const db = dbClient;
        try {
            await dbClient.query("begin");
            const userRecord = await (0, auth_repo_1.findAuthUserByPhone)(phoneE164, db, { forUpdate: true });
            if (!userRecord) {
                await dbClient.query("commit");
                (0, logger_1.logWarn)("otp_verify_response", { ...meta, providerStatus, userFound: false, tokenCreated: false, ok: false, error: "user_not_found" });
                return { ok: false, status: 404, error: { code: "user_not_found", message: "User not found" } };
            }
            if (userRecord.active !== true &&
                userRecord.isActive !== false &&
                userRecord.disabled !== true) {
                await (0, auth_repo_1.setUserActive)(userRecord.id, true, db);
            }
            assertUserActive({ user: userRecord, requestId, phoneTail: meta.phoneTail });
            await db.query("update users set phone_verified = $1, updated_at = $2 where id = $3", [true, new Date(), userRecord.id]);
            if (latestVerification?.status === "pending") {
                await safeUpdateOtpVerificationStatus({ id: latestVerification.id, status: "approved", verifiedAt: new Date(), client: db, requestId });
            }
            const role = resolveAuthRole(userRecord.role);
            (0, lenderBinding_1.assertLenderBinding)({ role, lenderId: userRecord.lenderId });
            const tokenVersion = userRecord.tokenVersion ?? 0;
            let token = "";
            let refresh = null;
            try {
                token = issueAccessToken({
                    sub: userRecord.id,
                    role,
                    tokenVersion,
                    phone: userRecord.phoneNumber,
                    silo: resolveAuthSilo(userRecord.silo),
                    capabilities: (0, capabilities_1.fetchCapabilitiesForRole)(role),
                });
                refresh = issueRefreshToken({ userId: userRecord.id, tokenVersion });
                await (0, auth_repo_1.storeRefreshToken)({ userId: userRecord.id, token: refresh.token, tokenHash: refresh.tokenHash, expiresAt: refresh.expiresAt, client: db });
            }
            catch (tokenErr) {
                await dbClient.query("commit");
                (0, logger_1.logError)("otp_verify_token_created", {
                    ...meta,
                    providerStatus,
                    userFound: true,
                    tokenCreated: false,
                    reason: tokenErr instanceof Error ? tokenErr.message : "token_creation_failed",
                });
                (0, logger_1.logWarn)("otp_verify_response", { ...meta, providerStatus, userFound: true, tokenCreated: false, ok: false, error: "auth_token_creation_failed" });
                return { ok: false, status: 401, error: { code: "auth_token_creation_failed", message: "Failed to create auth token" } };
            }
            if (!token || !userRecord.id) {
                await dbClient.query("commit");
                (0, logger_1.logError)("otp_verify_token_created", { ...meta, providerStatus, userFound: true, tokenCreated: false, reason: "missing_token_or_user" });
                return { ok: false, status: 401, error: { code: "auth_token_creation_failed", message: "Failed to create auth token" } };
            }
            await (0, audit_service_1.recordAuditEvent)({
                action: "login",
                actorUserId: userRecord.id,
                targetUserId: userRecord.id,
                ip: params.ip ?? null,
                userAgent: params.userAgent ?? null,
                success: true,
                client: db,
            });
            await dbClient.query("commit");
            (0, logger_1.logInfo)("otp_verify_token_created", { ...meta, providerStatus, userFound: true, tokenCreated: true });
            (0, logger_1.logInfo)("otp_verify_response", { ...meta, providerStatus, userFound: true, tokenCreated: true, ok: true, error: null });
            return {
                ok: true,
                data: {
                    token,
                    refreshToken: refresh?.token ?? null,
                    user: {
                        id: userRecord.id,
                        role,
                        email: userRecord.email,
                    },
                    nextPath: "/portal",
                },
            };
        }
        catch (err) {
            await dbClient.query("rollback");
            throw err;
        }
        finally {
            dbClient.release();
        }
    }
    catch (err) {
        if (err instanceof errors_1.AppError && err.status < 500) {
            (0, logger_1.logWarn)("otp_verify_response", {
                requestId,
                phoneTail: dedupPhone ? fetchPhoneTail(dedupPhone) : "",
                providerStatus: "error",
                userFound: false,
                tokenCreated: false,
                ok: false,
                error: err.code,
            });
            return {
                ok: false,
                status: err.status,
                error: { code: err.code, message: err.message },
            };
        }
        const message = err?.message || "Twilio error";
        if (message.includes("Missing required env var")) {
            throw err;
        }
        if (err?.status === 400) {
            return {
                ok: false,
                status: 400,
                error: { code: "invalid_code", message },
            };
        }
        (0, logger_1.logWarn)("otp_verify_failed", {
            requestId,
            error: err instanceof Error ? err.message : "unknown_error",
        });
        return {
            ok: false,
            status: 500,
            error: { code: "twilio_error", message },
        };
    }
    finally {
        if (dedupPhone) {
            clearVerifyAttempt(dedupPhone);
        }
    }
}
async function refreshSession(params) {
    const requestId = (0, requestContext_1.fetchRequestId)() ?? "unknown";
    const replayGraceMs = 2 * 60 * 1000;
    const rawRefreshToken = params.refreshToken?.trim();
    try {
        const refreshToken = rawRefreshToken;
        if (!refreshToken) {
            return {
                ok: false,
                status: 400,
                error: { code: "invalid_request", message: "Refresh token is required." },
            };
        }
        const payload = resolveRefreshPayload(verifyRefreshToken(refreshToken));
        const tokenHash = (0, tokenUtils_1.hashRefreshToken)(refreshToken);
        const dbClient = await db_1.pool.connect();
        const db = dbClient;
        try {
            await dbClient.query("begin");
            const consumed = await (0, auth_repo_1.consumeRefreshToken)(tokenHash, db);
            if (!consumed || consumed.userId !== payload.userId) {
                const replayRecord = await (0, auth_repo_1.findRefreshTokenByHash)(tokenHash, db);
                const replayAgeMs = replayRecord?.revokedAt
                    ? Date.now() - replayRecord.revokedAt.getTime()
                    : null;
                if (replayRecord &&
                    replayRecord.userId === payload.userId &&
                    replayRecord.expiresAt.getTime() > Date.now() &&
                    replayAgeMs !== null &&
                    replayAgeMs <= replayGraceMs) {
                    const userRecord = await (0, auth_repo_1.findAuthUserById)(payload.userId, db);
                    if (!userRecord) {
                        await dbClient.query("commit");
                        await (0, auth_repo_1.revokeRefreshToken)(tokenHash);
                        return {
                            ok: false,
                            status: 401,
                            error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
                        };
                    }
                    assertUserActive({ user: userRecord, requestId });
                    let role;
                    try {
                        role = resolveAuthRole(userRecord.role);
                    }
                    catch (err) {
                        await dbClient.query("commit");
                        throw err;
                    }
                    (0, lenderBinding_1.assertLenderBinding)({ role, lenderId: userRecord.lenderId });
                    const tokenVersion = userRecord.tokenVersion ?? 0;
                    if (payload.tokenVersion !== tokenVersion) {
                        await dbClient.query("commit");
                        await (0, auth_repo_1.revokeRefreshToken)(tokenHash);
                        return {
                            ok: false,
                            status: 401,
                            error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
                        };
                    }
                    const activeToken = await (0, auth_repo_1.findActiveRefreshTokenForUser)(userRecord.id, db);
                    if (!activeToken) {
                        await dbClient.query("commit");
                        await (0, auth_repo_1.revokeRefreshToken)(tokenHash);
                        return {
                            ok: false,
                            status: 401,
                            error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
                        };
                    }
                    if (!registerRefreshReplay(tokenHash, replayGraceMs)) {
                        await dbClient.query("commit");
                        await (0, auth_repo_1.revokeRefreshToken)(tokenHash);
                        return {
                            ok: false,
                            status: 401,
                            error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
                        };
                    }
                    const token = issueAccessToken({
                        sub: userRecord.id,
                        role,
                        tokenVersion,
                        phone: userRecord.phoneNumber,
                        silo: resolveAuthSilo(userRecord.silo),
                        capabilities: (0, capabilities_1.fetchCapabilitiesForRole)(role),
                    });
                    await dbClient.query("commit");
                    return {
                        ok: true,
                        token,
                        refreshToken: activeToken.token,
                        user: {
                            id: userRecord.id,
                            role,
                            email: userRecord.email,
                        },
                    };
                }
                await dbClient.query("commit");
                await (0, auth_repo_1.revokeRefreshToken)(tokenHash);
                return {
                    ok: false,
                    status: 401,
                    error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
                };
            }
            const userRecord = await (0, auth_repo_1.findAuthUserById)(payload.userId, db);
            if (!userRecord) {
                await dbClient.query("commit");
                await (0, auth_repo_1.revokeRefreshToken)(tokenHash);
                return {
                    ok: false,
                    status: 401,
                    error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
                };
            }
            assertUserActive({ user: userRecord, requestId });
            let role;
            try {
                role = resolveAuthRole(userRecord.role);
            }
            catch (err) {
                await dbClient.query("commit");
                throw err;
            }
            (0, lenderBinding_1.assertLenderBinding)({ role, lenderId: userRecord.lenderId });
            const tokenVersion = userRecord.tokenVersion ?? 0;
            if (payload.tokenVersion !== tokenVersion) {
                await dbClient.query("commit");
                await (0, auth_repo_1.revokeRefreshToken)(tokenHash);
                return {
                    ok: false,
                    status: 401,
                    error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
                };
            }
            const token = issueAccessToken({
                sub: userRecord.id,
                role,
                tokenVersion,
                phone: userRecord.phoneNumber,
                silo: resolveAuthSilo(userRecord.silo),
                capabilities: (0, capabilities_1.fetchCapabilitiesForRole)(role),
            });
            const refreshed = issueRefreshToken({
                userId: userRecord.id,
                tokenVersion,
            });
            await (0, auth_repo_1.storeRefreshToken)({
                userId: userRecord.id,
                token: refreshed.token,
                tokenHash: refreshed.tokenHash,
                expiresAt: refreshed.expiresAt,
                client: db,
            });
            await (0, audit_service_1.recordAuditEvent)({
                action: "token_refreshed",
                actorUserId: userRecord.id,
                targetUserId: userRecord.id,
                ip: params.ip ?? null,
                userAgent: params.userAgent ?? null,
                success: true,
                client: db,
            });
            await dbClient.query("commit");
            return {
                ok: true,
                token,
                refreshToken: refreshed.token,
                user: {
                    id: userRecord.id,
                    role,
                    email: userRecord.email,
                },
            };
        }
        catch (err) {
            await dbClient.query("rollback");
            throw err;
        }
        finally {
            dbClient.release();
        }
    }
    catch (err) {
        if (err instanceof errors_1.AppError) {
            return {
                ok: false,
                status: err.status,
                error: { code: err.code, message: err.message },
            };
        }
        if (rawRefreshToken) {
            try {
                await (0, auth_repo_1.revokeRefreshToken)((0, tokenUtils_1.hashRefreshToken)(rawRefreshToken));
            }
            catch (revokeError) {
                (0, logger_1.logWarn)("refresh_token_revoke_failed", {
                    requestId,
                    error: revokeError instanceof Error ? revokeError.message : "unknown_error",
                });
            }
        }
        (0, logger_1.logWarn)("refresh_failed", {
            requestId,
            error: err instanceof Error ? err.message : "unknown_error",
        });
        return {
            ok: false,
            status: 500,
            error: {
                code: "auth_failed",
                message: "Authentication failed.",
            },
        };
    }
}
async function createUserAccount(params) {
    const dbClient = await db_1.pool.connect();
    const db = dbClient;
    const phoneNumber = params.phoneNumber && params.phoneNumber.trim().length > 0
        ? params.phoneNumber
        : generatePlaceholderPhoneNumber();
    try {
        await dbClient.query("begin");
        const lenderId = (0, lenderBinding_1.assertLenderBinding)({
            role: params.role,
            ...(params.lenderId !== undefined ? { lenderId: params.lenderId } : {}),
        });
        const createPayload = {
            phoneNumber,
            role: params.role,
            lenderId,
            active: config_1.config.env === "test",
            client: db,
            ...(params.email !== undefined ? { email: params.email } : {}),
        };
        const user = await (0, auth_repo_1.createUser)(createPayload);
        await (0, audit_service_1.recordAuditEvent)({
            action: "user_created",
            actorUserId: params.actorUserId ?? null,
            targetUserId: user.id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client: db,
        });
        await dbClient.query("commit");
        return { id: user.id, email: user.email, role: params.role };
    }
    catch (err) {
        await dbClient.query("rollback");
        await (0, audit_service_1.recordAuditEvent)({
            action: "user_created",
            actorUserId: params.actorUserId ?? null,
            targetUserId: null,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: false,
            client: db,
        });
        throw err;
    }
    finally {
        dbClient.release();
    }
}
