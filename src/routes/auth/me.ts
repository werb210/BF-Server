import { type Request, type Response } from "express";
import { DEFAULT_AUTH_SILO } from "../../auth/silo.js";
import { fetchRequestId } from "../../observability/requestContext.js";
import { findAuthUserById } from "../../modules/auth/auth.repo.js";
import { logError } from "../../observability/logger.js";
import { validateAuthMe } from "../../validation/auth.validation.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fetchAuthRequestId(res: Response): string {
  return res.locals.requestId ?? fetchRequestId() ?? "unknown";
}

function respondAuthError(
  res: Response,
  status: number,
  code: string,
  message: string
): void {
  const requestId = fetchAuthRequestId(res);
  res.set("Cache-Control", "no-store");
  res.status(status).json({
    success: false,
    code,
    message,
    data: null,
    ok: false,
    error: { code, message },
    requestId,
  });
}

function respondResponseValidationError(
  res: Response,
  route: string,
  requestId: string,
  errors: unknown
): void {
  logError("auth_response_validation_failed", {
    route,
    requestId,
    errors,
  });

  res.set("Cache-Control", "no-store");
  res.status(500).json({
    success: false,
    code: "invalid_response_shape",
    message: "Invalid auth response shape",
    data: null,
    ok: false,
    error: { code: "invalid_response_shape", message: "Invalid auth response shape" },
    requestId,
  });
}

export async function authMeHandler(
  req: Request,
  res: Response
): Promise<void> {
  const route = "/api/auth/me";
  const requestId = fetchAuthRequestId(res);

  try {
    const user = req.user;

    if (!user) {
      respondAuthError(
        res,
        401,
        "AUTH_REQUIRED",
        "Authentication required."
      );
      return;
    }

    // AUTH_ME_CLIENT_IDENTITY_v1 - OTP-verified CLIENT tokens are not users rows:
    // their sub is "client:<phone>" (not a UUID) and role is "client" (outside the
    // staff role enum). The UUID gate below returned 401 for every signed-in client,
    // so the client app's useAuth() got null, never learned the phone, and Maya
    // could not recognize the logged-in user. Return identity straight from the
    // verified token claims instead. This does NOT relax auth: requireAuth already
    // verified the JWT signature upstream.
    const rawRole = (user as { role?: unknown }).role;
    const isClientToken =
      (user as { isClient?: unknown }).isClient === true ||
      (typeof rawRole === "string" && rawRole.toLowerCase() === "client");
    if (isClientToken) {
      const clientPhone = typeof user.phone === "string" ? user.phone : null;
      const clientBody = {
        success: true as const,
        ok: true as const,
        data: {
          user: {
            id: String(user.userId ?? (clientPhone ? `client:${clientPhone}` : "client")),
            role: "client",
            silo: "BF",
            phone: clientPhone,
            first_name: null,
            last_name: null,
            email:
              typeof (user as { email?: unknown }).email === "string"
                ? (user as { email?: string }).email
                : null,
            silos: [] as string[],
          },
        },
      };
      res.set("Cache-Control", "no-store");
      res.status(200).json(clientBody);
      return;
    }

    const rawUserId = user.userId ?? "";
    if (!UUID_REGEX.test(rawUserId)) {
      respondAuthError(
        res,
        401,
        "invalid_token",
        "Session expired. Please log in again."
      );
      return;
    }

    let silo = user.silo;
    let firstName: string | null = null;
    let lastName: string | null = null;
    let email: string | null = null;
    let silos: string[] = [];

    try {
      const userRecord = await findAuthUserById(user.userId);
      firstName = userRecord?.first_name ?? null;
      lastName = userRecord?.last_name ?? null;
      email = userRecord?.email ?? null;
      silos = Array.isArray(userRecord?.silos) ? userRecord.silos : [];

      if (!user.siloFromToken) {
        if (userRecord?.silo?.trim()) {
          silo = userRecord.silo.trim();
        } else {
          silo = DEFAULT_AUTH_SILO;
        }
      }
    } catch (err) {
      logError("auth_me_user_lookup_failed", {
        route,
        requestId,
        userId: user.userId,
        err,
      });
      if (!user.siloFromToken) {
        silo = DEFAULT_AUTH_SILO;
      }
    }

    if (!silo?.trim()) {
      silo = DEFAULT_AUTH_SILO;
    }

    const responseBody = {
      success: true,
      ok: true,
      data: {
        user: {
          id: user.userId,
          role: user.role,
          silo,
          phone: user.phone,
          first_name: firstName,
          last_name: lastName,
          email,
          silos,
        },
      },
      userId: user.userId,
      role: user.role,
      silo,
      user: {
        id: user.userId,
        role: user.role,
        silo,
        phone: user.phone,
        first_name: firstName,
        last_name: lastName,
        email,
        silos,
      },
    };

    const validation = validateAuthMe(responseBody);
    if (!validation.success) {
      respondResponseValidationError(
        res,
        route,
        requestId,
        validation.error.flatten()
      );
      return;
    }

    res.set("Cache-Control", "no-store");
    res.status(200).json(responseBody);
  } catch (err) {
    logError("auth_me_failed", {
      route,
      requestId,
      err,
    });

    respondAuthError(
      res,
      401,
      "invalid_token",
      "Invalid or expired authorization token."
    );
  }
}
