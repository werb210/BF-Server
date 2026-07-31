// BF_SERVER_ACCOUNTANT_OTP_v1 - guard for the accountant document surface.
// Accountant tokens are signed with plain jwt.sign (no issuer/audience), the
// same as the client fallthrough token, so verifyAccessToken would reject them.
// Verify directly and insist on both the role and the contact binding: a token
// with the right role but no contact id can see nothing, which is the safe
// failure rather than an unscoped one.
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

export type AccountantIdentity = { contactId: string; phone: string | null };

export function readAccountantIdentity(req: Request): AccountantIdentity | null {
  const header = String(req.headers.authorization ?? "");
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!raw) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const decoded = jwt.verify(raw, secret) as Record<string, unknown>;
    if (String(decoded.role ?? "") !== "accountant") return null;
    const contactId = String(decoded.contactId ?? "").trim();
    if (!contactId) return null;
    return { contactId, phone: decoded.phone ? String(decoded.phone) : null };
  } catch {
    return null;
  }
}

export function requireAccountant(req: Request, res: Response, next: NextFunction): void {
  const identity = readAccountantIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "accountant_auth_required" });
    return;
  }
  (req as any).accountant = identity;
  next();
}

export default requireAccountant;
