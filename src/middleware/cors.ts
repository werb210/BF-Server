import { config } from "../config";
export function corsMiddleware(req: any, res: any, next: any) {
  const allowed = (config.cors.allowedOrigins || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  const defaultAllowed = [
    "https://staff.boreal.financial",
    "http://localhost:5173",
  ];
  const allowedOrigins = allowed.length > 0 ? allowed : defaultAllowed;

  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Idempotency-Key"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );

  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
}
