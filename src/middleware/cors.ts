import cors from "cors";
import { getCorsAllowlistConfig } from "../config";
import { getCorsAllowedHeaders } from "../startup/corsValidation";

const REQUIRED_PRODUCTION_ORIGINS = [
  "https://client.boreal.financial",
  "https://staff.boreal.financial",
  "https://server.boreal.financial",
] as const;

function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/$/, "");
}

function buildAllowedOrigins(): string[] {
  const legacyOrigins = [process.env.CLIENT_ORIGIN, process.env.PORTAL_ORIGIN];
  const configured = [...getCorsAllowlistConfig(), ...legacyOrigins, ...REQUIRED_PRODUCTION_ORIGINS]
    .filter((origin): origin is string => Boolean(origin))
    .map((origin) => normalizeOrigin(origin));

  return [...new Set(configured)];
}

const allowedOrigins = buildAllowedOrigins();
const allowedOriginSet = new Set(allowedOrigins);
const allowAllOrigins = allowedOriginSet.has("*");

export function getAllowedOrigins(): string[] {
  return [...allowedOrigins];
}

export const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (allowAllOrigins) {
      callback(null, true);
      return;
    }

    const normalizedOrigin = normalizeOrigin(origin);
    callback(null, allowedOriginSet.has(normalizedOrigin));
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: getCorsAllowedHeaders(),
  optionsSuccessStatus: 204,
});
