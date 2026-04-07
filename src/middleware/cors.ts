import cors from "cors";

const allowedProductionOrigins = [
  "https://boreal.financial",
  "https://www.boreal.financial",
  "https://client.boreal.financial",
  "https://staff.boreal.financial",
  "https://server.boreal.financial",
];

function isLegacyRoute(req: cors.CorsRequest): boolean {
  const url = (req as any).url ?? "";
  return url.startsWith("/api/public");
}

function isApiRoute(req: cors.CorsRequest): boolean {
  const url = (req as any).url ?? "";
  return url.startsWith("/api/") || url.startsWith("/api/v1/");
}

function configuredOrigins(): string[] {
  const csv = process.env.CORS_ALLOWED_ORIGINS ?? "";
  return csv
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin: string): boolean {
  if (configuredOrigins().includes(origin)) {
    return true;
  }

  if (allowedProductionOrigins.includes(origin)) {
    return true;
  }

  if (process.env.NODE_ENV !== "production" && origin?.includes("localhost")) {
    return true;
  }

  if (process.env.NODE_ENV !== "production") {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }

  return false;
}

export const corsMiddleware = cors((req, callback) => {
  if (isLegacyRoute(req)) {
    return callback(null, {
      origin: true,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      preflightContinue: true,
      optionsSuccessStatus: 200,
    });
  }

  if (!isApiRoute(req)) {
    return callback(null, {
      origin: true,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      preflightContinue: true,
      optionsSuccessStatus: 200,
    });
  }

  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!origin) {
    return callback(null, { origin: false, credentials: false, optionsSuccessStatus: 200 });
  }

  if (isAllowedOrigin(origin)) {
    return callback(null, { origin: true, credentials: true, optionsSuccessStatus: 200 });
  }

  return callback(new Error(`CORS blocked: ${origin}`), {
    origin: false,
    credentials: false,
    optionsSuccessStatus: 200,
  },
  );
});
