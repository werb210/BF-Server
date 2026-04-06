import cors from "cors";

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export const corsMiddleware = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    if (process.env.NODE_ENV !== "production" && origin.includes("localhost")) {
      return cb(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return cb(null, true);
    }

    return cb(new Error("CORS blocked"));
  },
  credentials: true,
});
