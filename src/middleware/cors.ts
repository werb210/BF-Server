import cors from "cors";
import { getEnv } from "../config/env";

const allowedProductionOrigins = [
  "https://boreal.financial",
  "https://www.boreal.financial",
  "https://client.boreal.financial",
  "https://staff.boreal.financial",
  "https://server.boreal.financial",
];

function isAllowedOrigin(origin: string, nodeEnv: string | undefined): boolean {
  if (allowedProductionOrigins.includes(origin)) {
    return true;
  }

  if (nodeEnv !== "production") {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }

  return false;
}

export const corsMiddleware = cors((req, callback) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const { NODE_ENV } = getEnv();

  if (!origin) {
    return callback(null, { origin: false, credentials: false });
  }

  if (isAllowedOrigin(origin, NODE_ENV)) {
    return callback(null, { origin: true, credentials: true });
  }

  return callback(new Error(`CORS blocked: ${origin}`), {
    origin: false,
    credentials: false,
  },
  );
});
