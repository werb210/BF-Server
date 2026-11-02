// BF_SERVER_v868_MAYA_ACTING_STAFF - Maya acts only as the signed-in staff member (ported from KS-server #46,
// KS_SERVER_v21_VISIBILITY_GAPS, the assistant part).
//
// The agent calls the /api/maya/staff/* tools with a service token and names the staff member it is working for in
// the body (staff_user_id). That id decides who an SMS is queued for, who a task is created by and whose marketing
// preview can be confirmed - so it must not be something the model (or anything else in the agent) can choose.
//
// When BF-Server forwards a staff member's Maya message it signs an X-Maya-Context token for that person (HS256,
// iss "bf-server", aud "agent", kind "maya_context", minted from the signed-in user's own session - see
// services/mayaContext.ts). The agent now hands that token back on every staff tool call. Here:
//   - the token's signature is checked, and its staff id is the acting staff member;
//   - a staff_user_id in the body that names anyone else is refused with 403 (staff_identity_mismatch);
//   - a silo in the body that is not the token's silo is refused with 403 (staff_silo_mismatch) - BF, BI and SLF
//     staff each act only in the silo they are signed in to;
//   - otherwise staff_user_id (and silo, when the token carries one) are set to the verified values, so every
//     handler downstream reads the verified person.
// A call without a context (an agent build from before this change) runs as before and is logged, so the old agent
// keeps working until the new one is deployed.
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

export type ActingStaff = { id: string | null; silo: string | null; mismatch: false | "staff" | "silo" };

const CONTEXT_HEADER = "x-maya-context";

function verifiedContext(req: Request): { id: string; silo: string | null } | null {
  const token = String(req.header(CONTEXT_HEADER) ?? "").trim();
  const secret = String(process.env.JWT_SECRET ?? "").trim();
  if (!token || !secret) return null;
  try {
    const p = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: "bf-server", audience: "agent" }) as Record<string, any>;
    if (p?.kind !== "maya_context" || String(p.audience ?? "").toLowerCase() !== "staff") return null;
    const id = typeof p.staff?.id === "string" ? p.staff.id.trim() : "";
    if (!id) return null;
    const silo = typeof p.silo === "string" && p.silo.trim() ? p.silo.trim().toUpperCase() : null;
    return { id, silo };
  } catch {
    return null;
  }
}

/** Who the assistant is acting for: only ever the staff member in the context this server signed. */
export function actingStaffFromRequest(req: Request): ActingStaff {
  const body = ((req as any).body ?? {}) as Record<string, unknown>;
  const ctx = verifiedContext(req);
  if (!ctx) return { id: null, silo: null, mismatch: false };
  const claimed = typeof body.staff_user_id === "string" ? body.staff_user_id.trim() : "";
  if (claimed && claimed.toLowerCase() !== ctx.id.toLowerCase()) return { ...ctx, mismatch: "staff" };
  const claimedSilo = typeof body.silo === "string" ? body.silo.trim().toUpperCase() : "";
  if (ctx.silo && claimedSilo && claimedSilo !== ctx.silo) return { ...ctx, mismatch: "silo" };
  return { ...ctx, mismatch: false };
}

/**
 * For the assistant's staff routes. `isService` says whether the request carries a verified agent service token;
 * anything else (a staff member's own token) is left to the route's own checks.
 */
export function mayaActingStaff(isService: (req: Request) => boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isService(req)) return next();
    const acting = actingStaffFromRequest(req);
    if (acting.mismatch === "staff") {
      console.warn("[maya] staff tool refused: staff_user_id does not match the signed context", { path: req.path, actingStaffId: acting.id });
      res.status(403).json({ ok: false, error: "staff_identity_mismatch", message: "The acting staff member does not match the signed session." });
      return;
    }
    if (acting.mismatch === "silo") {
      console.warn("[maya] staff tool refused: silo does not match the signed context", { path: req.path, actingStaffId: acting.id, silo: acting.silo });
      res.status(403).json({ ok: false, error: "staff_silo_mismatch", message: "The silo does not match the signed session." });
      return;
    }
    const body = (req as any).body;
    if (acting.id) {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        body.staff_user_id = acting.id;
        if (acting.silo) body.silo = acting.silo;
      }
    } else if (body && typeof body === "object" && typeof body.staff_user_id === "string" && body.staff_user_id.trim()) {
      // An older agent build: nothing to check the id against yet. Logged so it shows up until the agent is updated.
      console.warn("[maya] staff tool called without a signed context; staff_user_id is unverified", { path: req.path });
    }
    next();
  };
}
