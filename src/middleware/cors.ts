import cors from "cors";

const allowedOrigins = (
  process.env.CORS_ALLOWED_ORIGINS ||
  "https://boreal.financial,https://www.boreal.financial,https://client.boreal.financial,https://staff.boreal.financial,https://server.boreal.financial"
)
  .split(",")
  .map((o) => o.trim());

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin) || origin.includes("localhost")) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
});
