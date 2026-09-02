import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../db.js";

const ACCESS_SECONDS = 15 * 60;
export const hashWatchSecret = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
export const newWatchSecret = (): string => crypto.randomBytes(32).toString("base64url");

function secret(): string {
  const base = process.env.WATCH_JWT_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error("watch_auth_not_configured");
  // A derived key prevents a Watch token from being accepted by the legacy staff
  // middleware when a dedicated production key has not yet been configured.
  return process.env.WATCH_JWT_SECRET ? base : `${base}:boreal-watch`;
}

export function issueWatchAccessToken(staffUserId: string, deviceId: string, sessionId: string) {
  const expiresAt = new Date(Date.now() + ACCESS_SECONDS * 1000);
  const accessToken = jwt.sign(
    { sub: staffUserId, deviceId, sessionId, tokenType: "watch_access" },
    secret(),
    { algorithm: "HS256", audience: "boreal-dialer-watch", issuer: "bf-server", expiresIn: ACCESS_SECONDS },
  );
  return { accessToken, expiresAt };
}

export async function watchAuth(req: Request, res: Response, next: NextFunction) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(req.header("authorization") || "");
  if (!match) return watchError(req, res, 401, "unauthenticated", "Authentication required");
  try {
    const claims = jwt.verify(match[1]!, secret(), {
      algorithms: ["HS256"], audience: "boreal-dialer-watch", issuer: "bf-server",
    }) as jwt.JwtPayload;
    if (claims.tokenType !== "watch_access" || typeof claims.sub !== "string" ||
        typeof claims.deviceId !== "string" || typeof claims.sessionId !== "string") throw new Error("bad_claims");
    const active = await pool.query(
      `SELECT s.id, d.staff_user_id, u.role, u.silo, u.silos
         FROM watch_sessions s JOIN watch_devices d ON d.id=s.device_id JOIN users u ON u.id=d.staff_user_id
        WHERE s.id=$1 AND s.device_id=$2 AND d.staff_user_id=$3
          AND s.revoked_at IS NULL AND s.expires_at > now() AND d.revoked_at IS NULL
          AND COALESCE(u.is_active, true)=true AND u.deleted_at IS NULL LIMIT 1`,
      [claims.sessionId, claims.deviceId, claims.sub],
    );
    if (!active.rows[0]) return watchError(req, res, 401, "unauthenticated", "Session is no longer active");
    (req as any).watch = { staffUserId: claims.sub, deviceId: claims.deviceId, sessionId: claims.sessionId };
    (req as any).user = { userId: claims.sub, id: claims.sub, role: active.rows[0].role,
      silo: active.rows[0].silo, silos: active.rows[0].silos || [] };
    await pool.query(`UPDATE watch_devices SET last_seen_at=now(), updated_at=now() WHERE id=$1`, [claims.deviceId]);
    return next();
  } catch {
    return watchError(req, res, 401, "unauthenticated", "Invalid or expired session");
  }
}

export function watchError(req: Request, res: Response, status: number, code: string, message: string, retryable = false) {
  return res.status(status).json({ error: { code, message, retryable, requestId: req.header("x-request-id") || (req as any).id || null } });
}

export function allowedLine(req: Request, line: unknown): "BF" | "BI" | "SLF" | null {
  const normalized = String(line || "").toUpperCase();
  if (!["BF", "BI", "SLF"].includes(normalized)) return null;
  const user = (req as any).user || {};
  const granted = new Set([user.silo, ...(Array.isArray(user.silos) ? user.silos : [])].map((x) => String(x || "").toUpperCase()));
  return granted.has(normalized) ? normalized as "BF" | "BI" | "SLF" : null;
}

