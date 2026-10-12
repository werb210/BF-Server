// BF_SERVER_v789_URL_TICKETS
// <img>, <audio>, EventSource and WebSocket cannot send an Authorization
// header, so a handful of staff routes read a token from the query string.
// Those query strings end up in proxy logs, browser history and Referer
// headers, so they no longer accept a full staff JWT. The portal asks
// POST /api/auth/url-ticket for a ticket instead: a JWT
// {kind: "url_ticket", sub: <user id>, aud: "bf-url", tv} that lives 60 seconds,
// is signed with a key derived from JWT_SECRET (so neither kind of token can
// stand in for the other), and is checked against the user exactly like a
// staff token (active, not disabled or locked, tv current).
import jwt from "jsonwebtoken";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { checkStaffUser } from "./staffUserState.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";

export const URL_TICKET_KIND = "url_ticket";
export const URL_TICKET_AUDIENCE = "bf-url";
export const URL_TICKET_TTL_SECONDS = 60;

function ticketSecret(): string | null {
  const base = typeof process.env.JWT_SECRET === "string" ? process.env.JWT_SECRET.trim() : "";
  return base ? `${base}:bf-url-ticket` : null;
}

export function signUrlTicket(userId: string, tokenVersion: number): string {
  const secret = ticketSecret();
  if (!secret) throw new Error("url ticket secret is not configured");
  return jwt.sign({ kind: URL_TICKET_KIND, tv: tokenVersion }, secret, {
    algorithm: "HS256",
    subject: userId,
    audience: URL_TICKET_AUDIENCE,
    expiresIn: URL_TICKET_TTL_SECONDS,
  });
}

export type UrlTicketResult =
  | { ok: true; user: Record<string, unknown> }
  | { ok: false; status: 401 | 403 | 503; reason: string };

// Verifies the ticket and the user behind it. Anything that is not a live
// url_ticket (a full staff JWT included) is a 401.
export async function authenticateUrlTicket(token: string | null | undefined): Promise<UrlTicketResult> {
  const secret = ticketSecret();
  if (!token || !secret) return { ok: false, status: 401, reason: "no_ticket" };
  let claims: Record<string, unknown>;
  try {
    const verified = jwt.verify(token, secret, { algorithms: ["HS256"], audience: URL_TICKET_AUDIENCE });
    if (!verified || typeof verified !== "object") return { ok: false, status: 401, reason: "invalid_ticket" };
    claims = verified as Record<string, unknown>;
  } catch {
    return { ok: false, status: 401, reason: "invalid_ticket" };
  }
  if (claims.kind !== URL_TICKET_KIND || typeof claims.sub !== "string" || !claims.sub) {
    return { ok: false, status: 401, reason: "invalid_ticket" };
  }
  const userId = claims.sub;
  const check = await checkStaffUser(userId, { tv: claims.tv }, { profile: true });
  if (!check.ok) return { ok: false, status: check.status, reason: check.reason };
  const profile = check.record.profile ?? {};
  return {
    ok: true,
    user: {
      ...profile,
      id: userId,
      sub: userId,
      userId,
      role: check.role,
      capabilities: check.capabilities,
      silos: Array.isArray(profile.silos) ? profile.silos : [],
      isServicePrincipal: false,
      serviceName: null,
      actorResolved: true,
      viaUrlTicket: true,
    },
  };
}

export function queryToken(req: Request): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function reject(res: Response, status: number): void {
  res.status(status).json({ error: status === 503 ? "auth_unavailable" : status === 403 ? "forbidden" : "unauthorized" });
}

// Accepts ?token=<url ticket> or, when there is no query token, whatever the
// given header middleware accepts. A query token that is not a valid ticket
// is a 401 even when a header is also present.
export function urlTicketOrHeaderAuth(headerAuth: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const ticket = queryToken(req);
    if (!ticket) return headerAuth(req, res, next);
    void authenticateUrlTicket(ticket).then((result) => {
      if (!result.ok) return reject(res, result.status);
      (req as any).user = result.user;
      urlTicketRequests.add(req);
      res.locals.silo = resolveSiloFromRequest(req);
      return next();
    }, next);
  };
}

const urlTicketRequests = new WeakSet<object>();

// For routers that put a header middleware in front of every route
// (router.use(requireAuth)): a request already admitted by
// urlTicketOrHeaderAuth earlier in the same chain passes; anything else goes
// through headerAuth as before.
export function unlessUrlTicket(headerAuth: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (urlTicketRequests.has(req)) return next();
    return headerAuth(req, res, next);
  };
}
