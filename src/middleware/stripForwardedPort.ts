// BF_SERVER_v885_IP_NO_PORT - Azure App Service adds the client's port to X-Forwarded-For ("203.0.113.5:51234"), so
// req.ip (and every IP saved from it: audit, consent, fraud signals) carried a port. Strip it from IPv4 entries before
// Express reads the header. IPv6 entries ("[2001:db8::1]:443" or bare) keep their address, without the brackets/port.
import type { NextFunction, Request, Response } from "express";

export function stripPort(entry: string): string {
  const v = entry.trim();
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v);
  if (v4) return v4[1]!;
  const v6 = /^\[([0-9a-fA-F:.]+)\](?::\d+)?$/.exec(v);
  if (v6) return v6[1]!;
  return v;
}

export function stripForwardedPort(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.headers["x-forwarded-for"];
  if (typeof raw === "string" && raw) req.headers["x-forwarded-for"] = raw.split(",").map(stripPort).join(", ");
  next();
}
