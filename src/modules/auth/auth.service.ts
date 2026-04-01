import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import { createHash, randomUUID } from "crypto";
import { type PoolClient } from "pg";
import {
  createUser,
  findAuthUserByPhone,
  findAuthUserById,
  findLatestOtpVerificationByPhone,
  findLatestOtpSessionByPhone,
  createOtpSession,
  createOtpCode,
  findLatestOtpCodeByPhone,
  deleteOtpCodesByPhone,
  createOtpVerification,
  updateOtpVerificationStatus,
  setUserActive,
  storeRefreshToken,
  consumeRefreshToken,
  findActiveRefreshTokenForUser,
  findRefreshTokenByHash,
  revokeRefreshToken,
} from "./auth.repo";
import { AppError, forbiddenError } from "../../middleware/errors";
import { recordAuditEvent } from "../audit/audit.service";
import { pool } from "../../db";
import { type Role, isRole } from "../../auth/roles";
import { logError, logInfo, logWarn } from "../../observability/logger";
import { fetchRequestId } from "../../middleware/requestContext";
import { normalizeOtpPhone } from "./phone";
import { ensureOtpTableExists } from "../../db/ensureOtpTable";
import { config } from "../../config";
import {
  signAccessToken,
  type AccessTokenPayload,
} from "../../auth/jwt";
import { DEFAULT_AUTH_SILO } from "../../auth/silo";
import { hashRefreshToken } from "../../auth/tokenUtils";
import { fetchCapabilitiesForRole } from "../../auth/capabilities";
import { fetchTwilioClient, fetchVerifyServiceSid } from "../../services/twilio";
import { assertLenderBinding } from "../../auth/lenderBinding";

const OTP_TRACE = (...args: any[]) => {
  console.log("[OTP_TRACE]", ...args);
};

const OTP_SESSION_TTL_MS = 10 * 60 * 1000;

type RefreshTokenPayload = JwtPayload & {
  sub?: string;
  tokenVersion?: number;
  type?: string;
  jti?: string;
};

type VerifyOtpSuccess = {
  ok: true;
  data: {
    token: string;
    refreshToken: string | null;
    user: { id: string; role: Role; email: string | null };
    nextPath: "/portal";
  };
};

type VerifyOtpFailure = {
  ok: false;
  status: number;
  error: { code: string; message: string };
};

const refreshReplayGuard = new Map<string, NodeJS.Timeout>();
const MAX_RUNTIME_AUTH_ENTRIES = 1000;

function trimMapSize(map: Map<string, unknown>, max = MAX_RUNTIME_AUTH_ENTRIES): void {
  if (map.size > max) {
    const firstKey = map.keys().next().value;
    if (firstKey) {
      map.delete(firstKey);
    }
  }
}

function registerRefreshReplay(tokenHash: string, windowMs: number): boolean {
  if (refreshReplayGuard.has(tokenHash)) {
    return false;
  }
  const timeout = setTimeout(() => refreshReplayGuard.delete(tokenHash), windowMs);
  timeout.unref();
  refreshReplayGuard.set(tokenHash, timeout);
  trimMapSize(refreshReplayGuard as unknown as Map<string, unknown>);
  return true;
}

function assertE164(phone: unknown): string {
  const normalized = normalizeOtpPhone(phone);
  if (!normalized) {
    throw new Error("Phone number must be in E.164 format");
  }
  return normalized;
}

export function issueAccessToken(payload: AccessTokenPayload): string {
  try {
    return signAccessToken(payload);
  } catch (err) {
    throw new AppError("auth_misconfigured", "Auth is not configured.", 500);
  }
}


export function issueRefreshToken(params: {
  userId: string;
  tokenVersion: number;
}): { token: string; tokenHash: string; expiresAt: Date } {
  const secret = config.auth.refreshSecret;
  if (!secret) {
    throw new AppError("auth_misconfigured", "Auth is not configured.", 500);
  }
  const payload: RefreshTokenPayload = {
    sub: params.userId,
    tokenVersion: params.tokenVersion,
    type: "refresh",
    jti: randomUUID(),
  };
  const expiresIn = config.auth.refreshExpiresMs as SignOptions["expiresIn"];
  const options: SignOptions = {
    algorithm: "HS256",
  };
  if (expiresIn !== undefined) {
    options.expiresIn = expiresIn;
  }
  const token = jwt.sign(payload, secret, options);
  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + config.auth.refreshExpiresMs),
  };
}

function verifyRefreshToken(token: string): RefreshTokenPayload {
  const secret = config.auth.refreshSecret;
  if (!secret) {
    throw new AppError("auth_misconfigured", "Auth is not configured.", 500);
  }
  try {
    return jwt.verify(token, secret, {
      algorithms: ["HS256"],
      clockTolerance: config.auth.jwtClockSkewSeconds,
    }) as RefreshTokenPayload;
  } catch {
    throw new AppError("invalid_refresh_token", "Invalid refresh token.", 401);
  }
}

function resolveRefreshPayload(payload: RefreshTokenPayload): {
  userId: string;
  tokenVersion: number;
} {
  const userId = typeof payload.sub === "string" ? payload.sub : null;
  const tokenVersion =
    typeof payload.tokenVersion === "number" ? payload.tokenVersion : null;
  const type = payload.type;
  if (!userId || tokenVersion === null || type !== "refresh") {
    throw new AppError("invalid_refresh_token", "Invalid refresh token.", 401);
  }
  return { userId, tokenVersion };
}

function resolveAuthRole(role: string | null): Role {
  if (role && isRole(role)) {
    return role;
  }
  throw forbiddenError("User has no assigned role");
}

function resolveAuthSilo(silo: string | null | undefined): string {
  if (typeof silo === "string" && silo.trim().length > 0) {
    return silo.trim();
  }
  return DEFAULT_AUTH_SILO;
}

export function assertUserActive(params: {
  user: {
    id: string;
    active: boolean;
    isActive: boolean | null;
    disabled: boolean | null;
    lockedUntil: Date | null;
  };
  requestId: string;
  phoneTail?: string;
}): void {
  const { user, requestId, phoneTail } = params;
  if (user.disabled === true) {
    throw new AppError("account_disabled", "Account is disabled.", 403);
  }
  if (user.isActive === false) {
    logInfo("otp_verify_inactive_user", {
      userId: user.id,
      phoneTail,
      requestId,
    });
    throw new AppError("user_disabled", "Account is inactive.", 403);
  }
  const isActive = user.active === true || user.isActive === true;
  if (!isActive) {
    logInfo("otp_verify_inactive_user", {
      userId: user.id,
      phoneTail,
      requestId,
    });
    throw new AppError("user_disabled", "Account is inactive.", 403);
  }
  const isLocked = user.lockedUntil && user.lockedUntil.getTime() > Date.now();
  if (isLocked) {
    throw new AppError("locked", "Account is locked.", 403);
  }
}

export function assertAuthSubsystem(): void {
  const accessSecret = config.auth.jwtSecret;
  const refreshSecret = config.auth.refreshSecret;
  if (!accessSecret || !refreshSecret) {
    throw new AppError("auth_misconfigured", "Auth is not configured.", 500);
  }
}

type TwilioErrorDetails = {
  code?: number | string;
  status?: number;
  message: string;
};

const OTP_VERIFY_DEDUP_WINDOW_MS = 1500;
const otpVerifyInFlight = new Map<string, NodeJS.Timeout>();
const OTP_VERIFICATION_MAX_AGE_MS = 10 * 60 * 1000;
const OTP_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const otpAttemptState = new Map<string, { count: number; resetAt: number; lastCodeHash: string }>();

setInterval(() => {
  const now = Date.now();
  for (const [phone, state] of otpAttemptState.entries()) {
    if (state.resetAt <= now) {
      otpAttemptState.delete(phone);
    }
  }
}, 60_000).unref();

function ensureTestOtp(phoneE164: string): string {
  const forcedTestOtp = config.auth.testOtpCode?.trim();
  if (forcedTestOtp) {
    return forcedTestOtp;
  }
  const seed = `${phoneE164}:${Math.floor(Date.now() / (5 * 60 * 1000))}`;
  return (parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % 900000 + 100000).toString();
}

function hashOtpCode(code: string): string {
  const salt = config.auth.otpHashSalt?.trim() || config.twilio.authToken?.trim() || "staff-server-otp";
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function assertOtpAttemptLimit(phoneE164: string): void {
  const current = otpAttemptState.get(phoneE164);
  const now = Date.now();
  if (!current || current.resetAt <= now) {
    return;
  }
  if (current.count >= OTP_MAX_VERIFY_ATTEMPTS) {
    throw new AppError("too_many_attempts", "Too many OTP attempts. Please request a new code.", 429);
  }
}

function recordOtpAttempt(phoneE164: string, codeHash: string): void {
  const now = Date.now();
  const current = otpAttemptState.get(phoneE164);
  if (!current || current.resetAt <= now) {
    otpAttemptState.set(phoneE164, { count: 1, resetAt: now + OTP_ATTEMPT_WINDOW_MS, lastCodeHash: codeHash });
    trimMapSize(otpAttemptState as unknown as Map<string, unknown>);
    return;
  }
  current.count += 1;
  current.lastCodeHash = codeHash;
}

function clearOtpAttemptLimit(phoneE164: string): void {
  otpAttemptState.delete(phoneE164);
}

function assertSingleVerifyAttempt(phoneE164: string): void {
  if (config.env === "test") {
    return;
  }
  if (otpVerifyInFlight.has(phoneE164)) {
    throw new AppError(
      "otp_verify_in_progress",
      "OTP verification already in progress.",
      429
    );
  }
  const timeout = setTimeout(() => {
    otpVerifyInFlight.delete(phoneE164);
  }, OTP_VERIFY_DEDUP_WINDOW_MS);
  timeout.unref();
  otpVerifyInFlight.set(phoneE164, timeout);
  trimMapSize(otpVerifyInFlight as unknown as Map<string, unknown>);
}

function clearVerifyAttempt(phoneE164: string): void {
  const timeout = otpVerifyInFlight.get(phoneE164);
  if (timeout) {
    clearTimeout(timeout);
    otpVerifyInFlight.delete(phoneE164);
  }
}

function fetchTwilioErrorDetails(error: unknown): TwilioErrorDetails {
  if (error && typeof error === "object") {
    const err = error as {
      code?: unknown;
      status?: unknown;
      message?: unknown;
    };
    const details: TwilioErrorDetails = {
      message:
        typeof err.message === "string"
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

function isTwilioAuthError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 20003
  );
}

function isTwilioUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    return ["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(
      code
    );
  }
  return false;
}

function attachTwilioDetails(error: AppError, details: TwilioErrorDetails): AppError {
  const twilioCode =
    typeof details.code === "number" || typeof details.code === "string"
      ? details.code
      : undefined;
  const twilioMessage = details.message;
  (error as { details?: unknown }).details = {
    twilioCode,
    twilioMessage,
  };
  return error;
}

function mapTwilioVerifyError(details: TwilioErrorDetails, err: unknown): AppError {
  if (isTwilioAuthError(err)) {
    return attachTwilioDetails(
      new AppError(
        "twilio_auth_failed",
        "Twilio authentication failed.",
        500
      ),
      details
    );
  }

  const codeValue =
    typeof details.code === "string" ? Number(details.code) : details.code;

  if (codeValue === 60203) {
    return attachTwilioDetails(
      new AppError("too_many_attempts", details.message, 429),
      details
    );
  }

  if (codeValue === 60202) {
    return attachTwilioDetails(
      new AppError("expired_code", details.message, 410),
      details
    );
  }

  if (codeValue === 60200 || codeValue === 20404 || details.status === 404) {
    return attachTwilioDetails(
      new AppError("invalid_code", details.message, 400),
      details
    );
  }

  if (details.status && details.status >= 500) {
    return attachTwilioDetails(
      new AppError("twilio_error", details.message, 500),
      details
    );
  }

  if (isTwilioUnavailableError(err)) {
    return attachTwilioDetails(
      new AppError("twilio_error", details.message, 500),
      details
    );
  }

  return attachTwilioDetails(
    new AppError("twilio_error", details.message, 500),
    details
  );
}

function mapTwilioVerifyCheckFailure(
  details: TwilioErrorDetails,
  err: unknown
): VerifyOtpFailure {
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

  const codeValue =
    typeof details.code === "string" ? Number(details.code) : details.code;

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

function fetchPhoneTail(phoneE164: string): string {
  return phoneE164.slice(-2);
}

function isOtpVerificationFresh(record: {
  createdAt: Date;
  verifiedAt: Date | null;
}): boolean {
  const timestamp = record.verifiedAt ?? record.createdAt;
  return Date.now() - timestamp.valueOf() <= OTP_VERIFICATION_MAX_AGE_MS;
}

function isOtpSessionExpired(record: { expiresAt: Date }): boolean {
  return record.expiresAt.valueOf() <= Date.now();
}

function isMissingOtpTableError(error: unknown): boolean {
  if (!(typeof error === "object" && error !== null)) {
    return false;
  }
  const typedError = error as { code?: string; message?: string };
  return (
    typedError.code === "42P01" ||
    typedError.message?.includes("relation \"otp_verifications\" does not exist") === true ||
    typedError.message?.includes("relation \"otp_sessions\" does not exist") === true
  );
}

async function safeFindLatestOtpVerificationByPhone(
  phone: string,
  requestId: string
) {
  try {
    return await findLatestOtpVerificationByPhone({ phone });
  } catch (err) {
    if (isMissingOtpTableError(err)) {
      logWarn("otp_verification_table_missing", { requestId });
      return null;
    }
    throw err;
  }
}

async function safeFindLatestOtpSessionByPhone(
  phone: string,
  requestId: string
) {
  try {
    return await findLatestOtpSessionByPhone({ phone });
  } catch (err) {
    if (isMissingOtpTableError(err)) {
      logWarn("otp_session_table_missing", { requestId });
      return null;
    }
    throw err;
  }
}

async function safeCreateOtpVerification(params: {
  userId: string;
  phone: string;
  verificationSid?: string | null;
  status: "pending" | "approved" | "expired";
  verifiedAt?: Date | null;
  client?: Pick<PoolClient, "query" | "runQuery">;
  requestId: string;
}): Promise<void> {
  try {
    await createOtpVerification({
      userId: params.userId,
      phone: params.phone,
      verificationSid: params.verificationSid ?? null,
      status: params.status,
      verifiedAt: params.verifiedAt ?? null,
      ...(params.client ? { client: params.client } : {}),
    });
  } catch (err) {
    if (isMissingOtpTableError(err)) {
      logWarn("otp_verification_table_missing", { requestId: params.requestId });
      return;
    }
    throw err;
  }
}

async function safeUpdateOtpVerificationStatus(params: {
  id: string;
  status: "pending" | "approved" | "expired";
  verifiedAt?: Date | null;
  client?: Pick<PoolClient, "query" | "runQuery">;
  requestId: string;
}): Promise<void> {
  try {
    await updateOtpVerificationStatus({
      id: params.id,
      status: params.status,
      verifiedAt: params.verifiedAt ?? null,
      ...(params.client ? { client: params.client } : {}),
    });
  } catch (err) {
    if (isMissingOtpTableError(err)) {
      logWarn("otp_verification_table_missing", { requestId: params.requestId });
      return;
    }
    throw err;
  }
}

function resolveOtpFailure(status?: string): VerifyOtpFailure {
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

function shouldLogFullOtpPhone(): boolean {
  return config.env !== "production" || config.auth.debugOtpPhone === "1";
}

function otpLogMeta(requestId: string, phoneE164: string): { requestId: string; phoneTail: string; normalizedPhone?: string } {
  return {
    requestId,
    phoneTail: fetchPhoneTail(phoneE164),
    ...(shouldLogFullOtpPhone() ? { normalizedPhone: phoneE164 } : {}),
  };
}

function generatePlaceholderPhoneNumber(): string {
  const raw = randomUUID().replace(/-/g, "");
  const digits = raw.replace(/[a-f]/gi, (value) =>
    (parseInt(value, 16) % 10).toString()
  );
  const suffix = digits.slice(0, 10);
  return `+1999${suffix}`;
}

async function createVerification(params: {
  twilioClient: ReturnType<typeof fetchTwilioClient>;
  serviceSid: string;
  to: string;
}): Promise<{ sid?: string; status?: string }> {
  const service = params.twilioClient.verify.v2.services(params.serviceSid);
  if (!service.verifications || typeof service.verifications.create !== "function") {
    throw new AppError("twilio_error", "Twilio verifications client is unavailable.", 500);
  }
  return service.verifications.create({ to: params.to, channel: "sms" });
}

async function createVerificationCheck(params: {
  twilioClient: ReturnType<typeof fetchTwilioClient>;
  serviceSid: string;
  to: string;
  code: string;
}): Promise<{ status?: string }> {
  const service = params.twilioClient.verify.v2.services(params.serviceSid);
  if (!service.verificationChecks || typeof service.verificationChecks.create !== "function") {
    throw new AppError("twilio_error", "Twilio verificationChecks client is unavailable.", 500);
  }
  return service.verificationChecks.create({ to: params.to, code: params.code });
}

export async function startOtp(
  phone: unknown
): Promise<{ ok: true; sid: string; otp?: string }> {
  const requestId = fetchRequestId() ?? "unknown";
  try {
    try {
      await ensureOtpTableExists();
    } catch (err) {
      logError("otp_schema_self_heal_failed", { err, requestId });
    }

    let phoneE164: string;
    try {
      phoneE164 = assertE164(phone);
    } catch {
      const phoneTail = typeof phone === "string" ? fetchPhoneTail(phone.trim()) : "";
      logWarn("otp_start_received", {
        requestId,
        phoneTail,
        ok: false,
        error: "invalid_phone",
      });
      throw new AppError("invalid_phone", "Invalid phone number", 400);
    }

    const startMeta = otpLogMeta(requestId, phoneE164);
    logInfo("otp_start_received", {
      ...startMeta,
      ok: true,
    });

    const twilioClient = fetchTwilioClient();
    const serviceSid = fetchVerifyServiceSid();
    clearOtpAttemptLimit(phoneE164);

    if (config.env === "test") {
      const generatedOtp = ensureTestOtp(phoneE164);
      await createOtpCode({
        phone: phoneE164,
        code: generatedOtp,
      });
      const session = await createOtpSession({
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
        } catch {
        }
      }

      OTP_TRACE("OTP_START", {
        phone: phoneE164,
        code: generatedOtp,
        instance: process.pid,
        time: Date.now(),
      });
      logInfo("otp_start_sent", {
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
      const session = await createOtpSession({
        phone: phoneE164,
        code: "",
        expiresAt: new Date(Date.now() + OTP_SESSION_TTL_MS),
      });
      const verification = await createVerification({
        twilioClient,
        serviceSid,
        to: phoneE164,
      });
      logInfo("otp_start_sent", {
        ...startMeta,
        serviceSid,
        verificationSid: verification.sid,
        providerStatus: verification.status,
      });
      try {
        const userRecord = await findAuthUserByPhone(phoneE164);
        if (userRecord) {
          await safeCreateOtpVerification({
            userId: userRecord.id,
            phone: phoneE164,
            verificationSid: verification.sid ?? null,
            status: "pending",
            requestId,
          });
        }
      } catch (err) {
        logError("otp_start_record_failed", {
          requestId,
          error: err instanceof Error ? err.message : "unknown_error",
        });
      }
      return { ok: true, sid: verification.sid ?? session.id };
    } catch (err: any) {
      const details = fetchTwilioErrorDetails(err);
      logError("auth_twilio_verify_failed", {
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
  } catch (err) {
    logError("otp_start_failed", {
      requestId,
      error: err instanceof Error ? err.message : "unknown_error",
    });
    throw err;
  }
}

export async function verifyOtpCode(params: {
  phone: string;
  code: string;
  otpSessionId?: string;
  email?: string | null;
  ip?: string;
  userAgent?: string;
  route?: string;
  method?: string;
}): Promise<VerifyOtpSuccess | VerifyOtpFailure> {
  const requestId = fetchRequestId() ?? "unknown";
  let dedupPhone: string | null = null;
  try {
    try {
      await ensureOtpTableExists();
    } catch (err) {
      logError("otp_schema_self_heal_failed", { err, requestId });
    }

    const code = params.code?.trim() ?? "";
    const phoneE164 = normalizeOtpPhone(params.phone);
    if (!code || !phoneE164) {
      logWarn("otp_verify_received", {
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
    logInfo("otp_verify_received", {
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
      logWarn("otp_verify_response", {
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
    if ((!latestVerification || !isOtpVerificationFresh(latestVerification)) && config.env !== "test") {
      logWarn("otp_verify_response", {
        ...meta,
        providerStatus: "not_checked",
        userFound: false,
        tokenCreated: false,
        ok: false,
        error: "expired_code",
      });
      return { ok: false, status: 400, error: { code: "expired_code", message: "OTP session expired" } };
    }

    let providerStatus: string | undefined;
    if (
      latestVerification?.status === "approved" &&
      isOtpVerificationFresh(latestVerification)
    ) {
      providerStatus = "approved";
    }

    const twilioClient = fetchTwilioClient();
    const serviceSid = fetchVerifyServiceSid();

    if (providerStatus !== "approved") {
      try {
        const check = await createVerificationCheck({
          twilioClient,
          serviceSid,
          to: phoneE164,
          code,
        });
        providerStatus = check.status;
        logInfo("otp_verify_provider_result", {
          ...meta,
          providerStatus,
          userFound: false,
          tokenCreated: false,
        });
      } catch (err) {
        if (config.env === "test") {
          providerStatus = undefined;
        } else {
          const details = fetchTwilioErrorDetails(err);
          logError("auth_twilio_verify_failed", {
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
          logWarn("otp_verify_response", { ...meta, providerStatus: "provider_error", userFound: false, tokenCreated: false, ok: false, error: mapped.error.code });
          return mapped;
        }
      }

      if (config.env === "test" && providerStatus !== "approved") {
        const otpRecord = await findLatestOtpCodeByPhone({ phone: phoneE164 });
        if (!otpRecord) {
          recordOtpAttempt(phoneE164, codeHash);
          logInfo("otp_verify_provider_result", { ...meta, providerStatus: "missing", userFound: false, tokenCreated: false });
          return { ok: false, status: 400, error: { code: "invalid_code", message: "No code" } };
        }
        if (otpRecord.expiresAt.getTime() <= Date.now()) {
          recordOtpAttempt(phoneE164, codeHash);
          logInfo("otp_verify_provider_result", { ...meta, providerStatus: "expired", userFound: false, tokenCreated: false });
          return { ok: false, status: 400, error: { code: "expired_code", message: "Expired" } };
        }
        if (otpRecord.code !== code) {
          recordOtpAttempt(phoneE164, codeHash);
          logInfo("otp_verify_provider_result", { ...meta, providerStatus: "invalid", userFound: false, tokenCreated: false });
          return { ok: false, status: 400, error: { code: "invalid_code", message: "Invalid" } };
        }
        providerStatus = "approved";
      }
    }

    if (providerStatus !== "approved") {
      recordOtpAttempt(phoneE164, codeHash);
      const failure = resolveOtpFailure(providerStatus);
      logWarn("otp_verify_response", { ...meta, providerStatus, userFound: false, tokenCreated: false, ok: false, error: failure.error.code });
      return failure;
    }

    clearOtpAttemptLimit(phoneE164);
    await deleteOtpCodesByPhone({ phone: phoneE164 });

    const existingUser = await findAuthUserByPhone(phoneE164);
    logInfo("otp_verify_user_lookup", { ...meta, providerStatus, userFound: Boolean(existingUser), tokenCreated: false });
    if (!existingUser) {
      logWarn("otp_verify_response", { ...meta, providerStatus, userFound: false, tokenCreated: false, ok: false, error: "user_not_found" });
      return { ok: false, status: 404, error: { code: "user_not_found", message: "User not found" } };
    }

    const dbClient = await pool.connect();
    const db = dbClient;
    try {
      await dbClient.query("begin");
      const userRecord = await findAuthUserByPhone(phoneE164, db, { forUpdate: true });

      if (!userRecord) {
        await dbClient.query("commit");
        logWarn("otp_verify_response", { ...meta, providerStatus, userFound: false, tokenCreated: false, ok: false, error: "user_not_found" });
        return { ok: false, status: 404, error: { code: "user_not_found", message: "User not found" } };
      }

      if (
        userRecord.active !== true &&
        userRecord.isActive !== false &&
        userRecord.disabled !== true
      ) {
        await setUserActive(userRecord.id, true, db);
      }

      assertUserActive({ user: userRecord, requestId, phoneTail: meta.phoneTail });

      await db.query("update users set phone_verified = $1, updated_at = $2 where id = $3", [true, new Date(), userRecord.id]);

      if (latestVerification?.status === "pending") {
        await safeUpdateOtpVerificationStatus({ id: latestVerification.id, status: "approved", verifiedAt: new Date(), client: db, requestId });
      }

      const role = resolveAuthRole(userRecord.role);
      assertLenderBinding({ role, lenderId: userRecord.lenderId });

      const tokenVersion = userRecord.tokenVersion ?? 0;
      let token = "";
      let refresh: { token: string; tokenHash: string; expiresAt: Date } | null = null;
      try {
        token = issueAccessToken({
          sub: userRecord.id,
          role,
          tokenVersion,
          phone: userRecord.phoneNumber,
          silo: resolveAuthSilo(userRecord.silo),
          capabilities: fetchCapabilitiesForRole(role),
        });
        refresh = issueRefreshToken({ userId: userRecord.id, tokenVersion });
        await storeRefreshToken({ userId: userRecord.id, token: refresh.token, tokenHash: refresh.tokenHash, expiresAt: refresh.expiresAt, client: db });
      } catch (tokenErr) {
        await dbClient.query("commit");
        logError("otp_verify_token_created", {
          ...meta,
          providerStatus,
          userFound: true,
          tokenCreated: false,
          reason: tokenErr instanceof Error ? tokenErr.message : "token_creation_failed",
        });
        logWarn("otp_verify_response", { ...meta, providerStatus, userFound: true, tokenCreated: false, ok: false, error: "auth_token_creation_failed" });
        return { ok: false, status: 401, error: { code: "auth_token_creation_failed", message: "Failed to create auth token" } };
      }

      if (!token || !userRecord.id) {
        await dbClient.query("commit");
        logError("otp_verify_token_created", { ...meta, providerStatus, userFound: true, tokenCreated: false, reason: "missing_token_or_user" });
        return { ok: false, status: 401, error: { code: "auth_token_creation_failed", message: "Failed to create auth token" } };
      }

      await recordAuditEvent({
        action: "login",
        actorUserId: userRecord.id,
        targetUserId: userRecord.id,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        client: db,
      });

      await dbClient.query("commit");
      logInfo("otp_verify_token_created", { ...meta, providerStatus, userFound: true, tokenCreated: true });
      logInfo("otp_verify_response", { ...meta, providerStatus, userFound: true, tokenCreated: true, ok: true, error: null });
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
    } catch (err) {
      await dbClient.query("rollback");
      throw err;
    } finally {
      dbClient.release();
    }
  } catch (err: any) {
    if (err instanceof AppError && err.status < 500) {
      logWarn("otp_verify_response", {
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

    logWarn("otp_verify_failed", {
      requestId,
      error: err instanceof Error ? err.message : "unknown_error",
    });
    return {
      ok: false,
      status: 500,
      error: { code: "twilio_error", message },
    };
  } finally {
    if (dedupPhone) {
      clearVerifyAttempt(dedupPhone);
    }
  }
}

export async function refreshSession(params: {
  refreshToken: string;
  ip?: string;
  userAgent?: string;
}): Promise<
  | {
      ok: true;
      token: string;
      refreshToken: string;
      user: { id: string; role: Role; email: string | null };
    }
  | {
      ok: false,
      status: number,
      error: { code: string; message: string };
    }
> {
  const requestId = fetchRequestId() ?? "unknown";
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
    const tokenHash = hashRefreshToken(refreshToken);

    const dbClient = await pool.connect();
    const db = dbClient;
    try {
      await dbClient.query("begin");
      const consumed = await consumeRefreshToken(tokenHash, db);
      if (!consumed || consumed.userId !== payload.userId) {
        const replayRecord = await findRefreshTokenByHash(tokenHash, db);
        const replayAgeMs = replayRecord?.revokedAt
          ? Date.now() - replayRecord.revokedAt.getTime()
          : null;
        if (
          replayRecord &&
          replayRecord.userId === payload.userId &&
          replayRecord.expiresAt.getTime() > Date.now() &&
          replayAgeMs !== null &&
          replayAgeMs <= replayGraceMs
        ) {
          const userRecord = await findAuthUserById(payload.userId, db);
          if (!userRecord) {
            await dbClient.query("commit");
            await revokeRefreshToken(tokenHash);
            return {
              ok: false,
              status: 401,
              error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
            };
          }

          assertUserActive({ user: userRecord, requestId });

          let role: Role;
          try {
            role = resolveAuthRole(userRecord.role);
          } catch (err) {
            await dbClient.query("commit");
            throw err;
          }

          assertLenderBinding({ role, lenderId: userRecord.lenderId });

          const tokenVersion = userRecord.tokenVersion ?? 0;
          if (payload.tokenVersion !== tokenVersion) {
            await dbClient.query("commit");
            await revokeRefreshToken(tokenHash);
            return {
              ok: false,
              status: 401,
              error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
            };
          }

          const activeToken = await findActiveRefreshTokenForUser(userRecord.id, db);
          if (!activeToken) {
            await dbClient.query("commit");
            await revokeRefreshToken(tokenHash);
            return {
              ok: false,
              status: 401,
              error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
            };
          }

          if (!registerRefreshReplay(tokenHash, replayGraceMs)) {
            await dbClient.query("commit");
            await revokeRefreshToken(tokenHash);
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
            capabilities: fetchCapabilitiesForRole(role),
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
        await revokeRefreshToken(tokenHash);
        return {
          ok: false,
          status: 401,
          error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
        };
      }

      const userRecord = await findAuthUserById(payload.userId, db);
      if (!userRecord) {
        await dbClient.query("commit");
        await revokeRefreshToken(tokenHash);
        return {
          ok: false,
          status: 401,
          error: { code: "invalid_refresh_token", message: "Invalid refresh token." },
        };
      }

      assertUserActive({ user: userRecord, requestId });

      let role: Role;
      try {
        role = resolveAuthRole(userRecord.role);
      } catch (err) {
        await dbClient.query("commit");
        throw err;
      }

      assertLenderBinding({ role, lenderId: userRecord.lenderId });

      const tokenVersion = userRecord.tokenVersion ?? 0;
      if (payload.tokenVersion !== tokenVersion) {
        await dbClient.query("commit");
        await revokeRefreshToken(tokenHash);
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
        capabilities: fetchCapabilitiesForRole(role),
      });
      const refreshed = issueRefreshToken({
        userId: userRecord.id,
        tokenVersion,
      });
      await storeRefreshToken({
        userId: userRecord.id,
        token: refreshed.token,
        tokenHash: refreshed.tokenHash,
        expiresAt: refreshed.expiresAt,
        client: db,
      });

      await recordAuditEvent({
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
    } catch (err) {
      await dbClient.query("rollback");
      throw err;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    if (err instanceof AppError) {
      return {
        ok: false,
        status: err.status,
        error: { code: err.code, message: err.message },
      };
    }
    if (rawRefreshToken) {
      try {
        await revokeRefreshToken(hashRefreshToken(rawRefreshToken));
      } catch (revokeError) {
        logWarn("refresh_token_revoke_failed", {
          requestId,
          error: revokeError instanceof Error ? revokeError.message : "unknown_error",
        });
      }
    }
    logWarn("refresh_failed", {
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

export async function createUserAccount(params: {
  email?: string | null;
  phoneNumber?: string | null;
  role: Role;
  lenderId?: string | null;
  actorUserId?: string | null;
  ip?: string;
  userAgent?: string;
}): Promise<{ id: string; email: string | null; role: Role }> {
  const dbClient = await pool.connect();
  const db = dbClient;
  const phoneNumber =
    params.phoneNumber && params.phoneNumber.trim().length > 0
      ? params.phoneNumber
      : generatePlaceholderPhoneNumber();
  try {
    await dbClient.query("begin");
    const lenderId = assertLenderBinding({
      role: params.role,
      ...(params.lenderId !== undefined ? { lenderId: params.lenderId } : {}),
    });
    const createPayload = {
      phoneNumber,
      role: params.role,
      lenderId,
      active: config.env === "test",
      client: db,
      ...(params.email !== undefined ? { email: params.email } : {}),
    };
    const user = await createUser(createPayload);
    await recordAuditEvent({
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
  } catch (err) {
    await dbClient.query("rollback");
    await recordAuditEvent({
      action: "user_created",
      actorUserId: params.actorUserId ?? null,
      targetUserId: null,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: false,
      client: db,
    });
    throw err;
  } finally {
    dbClient.release();
  }
}
