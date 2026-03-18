import { Router, type NextFunction, type Request, type Response } from "express";
import { parse as parseQueryString } from "querystring";
import { AppError } from "../../middleware/errors";
import {
  otpRateLimit,
  verifyOtpRateLimit,
} from "../../middleware/rateLimit";
import { startOtp, verifyOtpCode } from "./otp.service";
import {
  startOtpResponseSchema,
  validateStartOtp,
  validateVerifyOtp,
  verifyOtpResponseSchema,
} from "../../validation/auth.validation";
import { requireAuth, requireAuthorization } from "../../middleware/auth";
import { ALL_ROLES } from "../../auth/roles";
import { isTestEnvironment } from "../../config";
import { normalizePhone } from "./phone";

const router = Router();

function coerceBody(body: unknown): Record<string, unknown> {
  if (!body) return {};
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return parseQueryString(trimmed) as Record<string, unknown>;
    }
  }
  if (typeof body === "object") return body as Record<string, unknown>;
  return {};
}

function respondError(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

function respondOk<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

router.post("/otp/start", otpRateLimit(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawBody = coerceBody(req.body);
    const phone = rawBody.phone ?? rawBody.phoneNumber ?? rawBody.phone_number ?? rawBody.mobile ?? null;
    req.body = { ...rawBody, ...(phone !== null ? { phone } : {}) };

    const validation = validateStartOtp(req);
    if (!validation.success) {
      respondError(res, 400, "Invalid request payload");
      return;
    }

    let normalizedPhone: string;
    try {
      normalizedPhone = normalizePhone(validation.data.phone);
    } catch {
      respondError(res, 400, "Invalid phone number");
      return;
    }

    const otpStartResult = await startOtp(normalizedPhone);
    const responseBody = { sent: true, ...(isTestEnvironment() ? { otp: otpStartResult.otp } : {}) };
    const responseValidation = startOtpResponseSchema.safeParse(responseBody);
    if (!responseValidation.success) {
      respondError(res, 500, "Invalid auth response shape");
      return;
    }

    respondOk(res, responseBody);
  } catch (err) {
    if (err instanceof AppError) {
      respondError(res, err.status, err.message);
      return;
    }
    next(err);
  }
});

router.post("/otp/verify", verifyOtpRateLimit(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawBody = coerceBody(req.body);
    const phone = rawBody.phone ?? rawBody.phoneNumber ?? rawBody.phone_number ?? rawBody.mobile ?? null;
    const codeRaw = rawBody.code ?? rawBody.otp ?? rawBody.token ?? null;
    req.body = { ...rawBody, ...(phone !== null ? { phone } : {}), ...(codeRaw !== null ? { code: codeRaw } : {}) };

    const validation = validateVerifyOtp(req);
    if (!validation.success) {
      respondError(res, 400, "Invalid request payload");
      return;
    }

    let normalizedPhone: string;
    try {
      normalizedPhone = normalizePhone(validation.data.phone);
    } catch {
      respondError(res, 400, "Invalid phone number");
      return;
    }

    const result = await verifyOtpCode({
      phone: normalizedPhone,
      code: validation.data.code,
      ...(validation.data.email !== undefined ? { email: validation.data.email } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.get("user-agent") ? { userAgent: req.get("user-agent") } : {}),
      route: "/api/auth/otp/verify",
      method: req.method,
    });

    if (!result.ok) {
      respondError(res, result.status, result.error.message);
      return;
    }

    const responseValidation = verifyOtpResponseSchema.safeParse(result);
    if (!responseValidation.success) {
      respondError(res, 500, "Invalid auth response shape");
      return;
    }

    res.status(200).json(result);
  } catch (err) {
    if (err instanceof AppError) {
      respondError(res, err.status, err.message);
      return;
    }
    next(err);
  }
});

router.get("/me", requireAuth, requireAuthorization({ roles: ALL_ROLES }), async (req, res) => {
  const user = req.user;
  if (!user) {
    respondError(res, 401, "Authorization token is required.");
    return;
  }

  respondOk(res, {
    user: {
      id: user.userId,
      role: user.role,
      silo: user.silo,
      phone: user.phone,
    },
  });
});

export default router;
