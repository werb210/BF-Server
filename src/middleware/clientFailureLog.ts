// BF_SERVER_CLIENT_FAILURE_LOG_v749
import type { NextFunction, Request, Response } from "express";

export type ClientFailure = {
  at: string; method: string; path: string; status: number; ms: number; hadAuth: boolean;
  appVersion: string | null; instance: string | null; uptimeS: number;
};

const MAX = 200;
const recent: ClientFailure[] = [];
export const startedAt = new Date().toISOString();

export function isClientFailure(status: number): boolean {
  return status === 401 || status === 403 || status >= 500;
}

export function recordClientFailure(f: ClientFailure): void {
  recent.push(f);
  if (recent.length > MAX) recent.splice(0, recent.length - MAX);
  console.warn("[client-failure] " + JSON.stringify(f));
}

export function recentClientFailures(): ClientFailure[] { return [...recent].reverse(); }
export function clearClientFailures(): void { recent.length = 0; }

export function clientFailureLog(req: Request, res: Response, next: NextFunction): void {
  const t0 = Date.now();
  res.on("finish", () => {
    if (!isClientFailure(res.statusCode)) return;
    const pathOnly = String(req.originalUrl ?? "").split("?")[0] ?? "";
    const version = req.headers["x-app-version"];
    recordClientFailure({
      at: new Date().toISOString(), method: req.method, path: pathOnly.slice(0, 200),
      status: res.statusCode, ms: Date.now() - t0, hadAuth: Boolean(req.headers.authorization),
      appVersion: typeof version === "string" ? version.slice(0, 40) : null,
      instance: process.env.WEBSITE_INSTANCE_ID ? String(process.env.WEBSITE_INSTANCE_ID).slice(0, 12) : null,
      uptimeS: Math.round(process.uptime()),
    });
  });
  next();
}
