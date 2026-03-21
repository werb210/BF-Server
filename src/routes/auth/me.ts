import { type Request, type Response } from "express";
import { DEFAULT_AUTH_SILO } from "../../auth/silo";
import { getRequestId } from "../../middleware/requestContext";
import { findAuthUserById } from "../../modules/auth/auth.repo";
import { logError } from "../../observability/logger";
import { validateAuthMe } from "../../validation/auth.validation";

function getAuthRequestId(res: Response): string {
  return res.locals.requestId ?? getRequestId() ?? "unknown";
}

function respondAuthError(
  res: Response,
  status: number,
  code: string,
  message: string
): void {
  const requestId = getAuthRequestId(res);
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
  const requestId = getAuthRequestId(res);

  try {
    const user = req.user;

    if (!user) {
      respondAuthError(
        res,
        401,
        "missing_token",
        "Authorization token is required."
      );
      return;
    }

    let silo = user.silo;
    if (!user.siloFromToken) {
      try {
        const userRecord = await findAuthUserById(user.userId);
        if (userRecord?.silo?.trim()) {
          silo = userRecord.silo.trim();
        } else {
          silo = DEFAULT_AUTH_SILO;
        }
      } catch (err) {
        logError("auth_me_silo_lookup_failed", {
          route,
          requestId,
          userId: user.userId,
          err,
        });
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
