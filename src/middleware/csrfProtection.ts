import type { RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/$/, "").toLowerCase();
}

function getTrustedOrigins(): Set<string> {
  const trustedOrigins = [process.env.CLIENT_URL, process.env.PORTAL_URL, process.env.WEBSITE_URL];

  if (process.env.NODE_ENV !== "production") {
    trustedOrigins.push("http://localhost", "http://localhost:3000", "http://localhost:5173");
  }

  return new Set(
    trustedOrigins
      .filter((origin): origin is string => typeof origin === "string" && origin.trim().length > 0)
      .map(normalizeOrigin)
  );
}

function isCsrfExemptPath(path: string): boolean {
  return (
    path.startsWith("/api/twilio") ||
    path.startsWith("/api/webhooks") ||
    path.startsWith("/api/voice")
  );
}

export const csrfProtection: RequestHandler = (req: any, res: any, next: any) => {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  if (isCsrfExemptPath(req.path)) {
    next();
    return;
  }

  const origin = req.get("origin") ?? req.get("referer");
  if (!origin) {
    next();
    return;
  }

  const trustedOrigins = getTrustedOrigins();
  const normalizedOrigin = normalizeOrigin(origin);

  if (!trustedOrigins.has(normalizedOrigin)) {
    res.status(403).json({
      ok: false,
      error: {
        code: "csrf_forbidden",
        message: "Request origin is not allowed.",
      },
    });
    return;
  }

  const csrfToken = req.get("x-csrf-token");
  const csrfCookie = req.get("cookie");
  const hasBrowserCookies = typeof csrfCookie === "string" && csrfCookie.includes("=");

  if (hasBrowserCookies && (!csrfToken || csrfToken.trim().length < 12)) {
    res.status(403).json({
      ok: false,
      error: {
        code: "csrf_token_required",
        message: "Missing CSRF token.",
      },
    });
    return;
  }

  next();
};
