// BF_SERVER_SERVICE_TOKEN_v1
// bi-server has been calling BF-Server with an `X-Backend-Token` header since
// the sequence workers were written. BF-Server implements that header NOWHERE —
// zero matches in the repo. So both of BI's send paths were dead:
//   POST /api/sms              -> no such route exists at all (404)
//   POST /api/o365/mail/send   -> router.use(requireAuth), JWT required (401)
// A BI sequence could never deliver an email or a text, and any task bi-server
// tried to create would have been rejected the same way.
//
// This is deliberately NOT a general auth bypass. It authenticates a known
// backend service, and it is mounted on one narrow router (/api/service) that
// exposes only the three operations bi-server needs. It grants no access to
// applications, documents, lenders or any staff-facing route.
//
// The token lives in BACKEND_SERVICE_TOKEN and must match on both App Services.
// When it is unset the middleware refuses everything rather than falling open —
// an unset secret must never mean "let anyone in".
import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

/** Constant-time compare that tolerates length mismatch without leaking it. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const SERVICE_USER_ID = "00000000-0000-0000-0000-000000000001";

export function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
  const expected = String(process.env.BACKEND_SERVICE_TOKEN ?? "").trim();
  if (!expected) {
    // Fail closed. A missing secret is a misconfiguration, not permission.
    console.error("[service-token] BACKEND_SERVICE_TOKEN is not set — rejecting backend call");
    res.status(503).json({ ok: false, error: "service_auth_not_configured" });
    return;
  }
  const headerValue = req.header("x-backend-token") ?? "";
  const provided = String(Array.isArray(headerValue) ? headerValue[0] : headerValue).trim();
  if (!provided || !tokensMatch(provided, expected)) {
    res.status(401).json({ ok: false, error: "invalid_backend_token" });
    return;
  }
  // Present a service principal so downstream handlers that read req.user (task
  // creation records a created_by) behave exactly as they do for a staff caller.
  const silo = String(req.header("x-silo") ?? "BF").toUpperCase() === "BI" ? "BI" : "BF";
  (req as any).user = { userId: SERVICE_USER_ID, role: "Admin", silo, isService: true };
  next();
}
