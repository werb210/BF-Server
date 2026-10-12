import { Request, Response, NextFunction, type RequestHandler } from "express";
import jwt from "jsonwebtoken";
// BF_AGENT_AUTH_HYDRATE_v53
import { fetchCapabilitiesForRole } from "../auth/capabilities.js";
import { isRole, ROLES } from "../auth/roles.js";
// BF_SERVER_BLOCK_BI_ROUND5_AUTH_SILO_REFRESH_v1 -- see comment by
// the call site below.
import { resolveSiloFromRequest } from "./silo.js";
// BF_SERVER_AUDIT_PRINCIPAL_CONTEXT_v1
import { markRequestServicePrincipal } from "../observability/requestContext.js";
// BF_SERVER_v784_STAFF_ONLY_AUTH
import { classifyClaims, staffRejectionStatus } from "../auth/principal.js";
// BF_SERVER_v789_STAFF_USER_STATE
import { checkStaffUser } from "../auth/staffUserState.js";
import { looksLikeServiceToken, verifyServiceToken } from "../auth/serviceTokens.js";

type AuthorizationOptions = {
  roles?: string[];
  capabilities?: string[];
};

type AppUser = NonNullable<Request["user"]> & {
  role?: string;
  capabilities?: string[];
};

export interface AuthRequest extends Request {
  user?: Request["user"];
}

// BF_SERVER_v784_STAFF_ONLY_AUTH - every token family is signed with JWT_SECRET,
// so a verified signature used to be enough to reach /api/companies, /api/tasks,
// /api/calendar, /api/slf/deals with a client OTP token or an SMS tracked-link
// token. The default middleware now admits only staff humans and service
// principals. Routes that legitimately serve the client app opt in by name with
// requireAuthAllowClient and check ownership themselves.
// BF_SERVER_v789_SAFE_HANDLERS - not async: a rejection inside authenticate goes to
// next(err) instead of becoming an unhandled rejection that hangs the request.
export function auth(req: Request, res: Response, next: NextFunction): Promise<void> {
  return authenticate(req, res, next, false).then(() => undefined, next);
}

export function requireAuthAllowClient(req: Request, res: Response, next: NextFunction): Promise<void> {
  return authenticate(req, res, next, true).then(() => undefined, next);
}

async function authenticate(req: Request, res: Response, next: NextFunction, allowClient: boolean) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  try {
    const JWT_SECRET = process.env.JWT_SECRET;

    if (!JWT_SECRET) {
      return res.status(500).json({ status: "error", message: "Auth not configured" });
    }

    // BF_SERVER_JWT_HARDENING_v1 - pin the algorithm; otherwise the library trusts the
    // `alg` the token itself claims, which is the classic algorithm-confusion foothold.
    // BF_SERVER_v789_SERVICE_TOKENS - a service token verifies with its sender's key
    // (BI_SERVICE_JWT_SECRET / AGENT_SERVICE_JWT_SECRET when set); everything else
    // with JWT_SECRET.
    const decoded = looksLikeServiceToken(token)
      ? verifyServiceToken(token).claims
      : jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (!decoded || typeof decoded !== "object") {
      return res.status(401).json({ status: "error", message: "Invalid token" });
    }
    const principal = classifyClaims(decoded as Record<string, unknown>);
    const rejection = allowClient && principal.kind === "client" ? null : staffRejectionStatus(principal);
    if (rejection) {
      return res.status(rejection).json({
        status: "error",
        message: rejection === 401 ? "Invalid token" : "Forbidden",
        error: rejection === 401 ? "UNAUTHORIZED" : "STAFF_ONLY",
      });
    }
    const userId = (decoded as any).id ?? (decoded as any).sub ?? null;
    const decodedAny = decoded as Record<string, unknown>;

    // BF_SERVER_v789_STAFF_USER_STATE - a staff human must still be an active,
    // unlocked account whose users.token_version the token's tv has not fallen
    // behind. The role comes from the database and token capabilities that role
    // does not grant are dropped. Service principals and client tokens have no
    // users row and skip this. A failed lookup is a logged 503, not a pass.
    let dbUser: Record<string, unknown> | null = null;
    let effectiveRole: string | null = typeof decodedAny.role === "string" ? decodedAny.role : null;
    let hydratedCaps: string[];
    if (principal.kind === "staff") {
      const check = await checkStaffUser(typeof userId === "string" ? userId : "", decodedAny, { profile: true });
      if (!check.ok) {
        return res.status(check.status).json({
          status: "error",
          message: check.status === 503 ? "Auth unavailable" : check.status === 403 ? "Forbidden" : "Invalid token",
          error: check.status === 503 ? "AUTH_UNAVAILABLE" : check.status === 403 ? "STAFF_ONLY" : "UNAUTHORIZED",
        });
      }
      dbUser = check.record.profile;
      effectiveRole = check.role;
      hydratedCaps = check.capabilities;
    } else {
      // BF_AGENT_AUTH_HYDRATE_v53 - service tokens (Maya, dialer) only include
      // {id, role}; derive capabilities from the role so they pass the
      // requireCapability gate. An explicit capabilities array is honored as-issued.
      const explicitCaps = Array.isArray(decodedAny.capabilities)
        ? (decodedAny.capabilities as string[])
        : null;
      hydratedCaps = explicitCaps
        ?? (effectiveRole && isRole(effectiveRole) ? fetchCapabilitiesForRole(effectiveRole) : []);
    }

    // BF_SERVER_SERVICE_PRINCIPAL_v1
    // Maya and the dialer authenticate as role Staff with an id that matches
    // no users row, so dbUser is null and every audit row they write carries a
    // dangling actor_user_id. AGENT_SERVICE_TOKEN_v1 adds principal/service
    // claims to the agent token; surface them here so downstream writers can
    // record who actually acted. Absent claims mean a human token: unchanged.
    const isServicePrincipal = decodedAny.principal === "service";

    (req as any).user = {
      ...(decoded as any),
      ...(dbUser ?? {}),
      ...(effectiveRole ? { role: effectiveRole } : {}),
      userId,
      capabilities: hydratedCaps,
      silos: (dbUser?.silos as string[] | null | undefined) ?? (Array.isArray((decoded as any).silos) ? (decoded as any).silos : []),
      isServicePrincipal,
      serviceName: isServicePrincipal ? String(decodedAny.service ?? "unknown") : null,
      // A service id that resolves to no users row is expected, not corruption.
      actorResolved: Boolean(dbUser),
    };

    // BF_SERVER_BLOCK_BI_ROUND5_AUTH_SILO_REFRESH_v1
    // The app-level siloMiddleware (applySiloMiddleware in app.ts)
    // runs BEFORE this auth handler. At that point req.user is
    // undefined, so it falls into the "Unauthenticated → BF" branch
    // and sets res.locals.silo = "BF". Authed routes then read
    // res.locals.silo (often via getSilo(res)) and always see "BF",
    // regardless of the X-Silo header, ?silo query, or user
    // allowlist -- which is why BI / SLF-silo users see BF data on
    // every endpoint that filters on res.locals.silo (portal.ts,
    // applications.routes.ts, portalLenderProducts.ts, crm.ts,
    // communications.ts, calls.ts, users.service.ts -- 46 call
    // sites total). Re-resolve here, now that req.user is set, so
    // every downstream getSilo(res) returns the correct value.
    // Every recordAuditEvent below this point picks the principal up from
    // the async store without the call site knowing about it.
    if (isServicePrincipal) markRequestServicePrincipal(String(decodedAny.service ?? "unknown"));

    res.locals.silo = resolveSiloFromRequest(req);

    next();
  } catch {
    return res.status(401).json({ status: "error", message: "Invalid token" });
  }
}

export const requireAuth: RequestHandler = auth;

export function createAuthMiddleware(): RequestHandler {
  return requireAuth;
}

export const authMiddleware: RequestHandler = requireAuth;

export function requireAuthorization(options: AuthorizationOptions = {}): RequestHandler {
  const requiredRoles = options.roles ?? [];
  const requiredCapabilities = options.capabilities ?? [];

  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AppUser | undefined;

    if (!user) {
      return res.status(401).json({ status: "error", error: "NO_TOKEN" });
    }

    // BF_SERVER_MARKETING_INHERITS_STAFF_v1 - a Marketing user has the same
    // access as a Staff user (Marketing-only surfaces are gated separately). Any
    // endpoint that admits Staff also admits Marketing, so Marketing staff are
    // not 403'd on the pipeline / CRM / communications endpoints (81 of which
    // gate on [ADMIN, STAFF]). Admin-only endpoints stay admin-only.
    const roleSatisfied =
      !!user.role &&
      (requiredRoles.includes(user.role) ||
        (user.role === ROLES.MARKETING && requiredRoles.includes(ROLES.STAFF)));
    if (requiredRoles.length > 0 && !roleSatisfied) {
      return res.status(403).json({ status: "error", error: "FORBIDDEN" });
    }

    if (requiredCapabilities.length > 0) {
      const userCapabilities = user.capabilities ?? [];
      const allowed = requiredCapabilities.some((capability) => userCapabilities.includes(capability));

      if (!allowed) {
        return res.status(403).json({ status: "error", error: "FORBIDDEN" });
      }
    }

    return next();
  };
}

export function requireCapability(capability: string | string[]): RequestHandler {
  return requireAuthorization({
    capabilities: Array.isArray(capability) ? capability : [capability],
  });
}
