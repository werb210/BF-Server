import { Router } from "express";

import applicationRoutes from "./applications.routes.js";
import documentRoutes from "./documents.js";
import userRoutes from "./users.js";

const router = Router();

router.use("/applications", applicationRoutes);
router.use("/documents", documentRoutes);
router.use("/users", userRoutes);

const requiredEnvKeys = ["NODE_ENV", "DATABASE_URL", "JWT_SECRET", "OPENAI_API_KEY"] as const;
const optionalEnvKeys = [
  "REDIS_URL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE",
  "SENTRY_DSN",
  "SLACK_ALERT_WEBHOOK_URL",
  "PUBLIC_BASE_URL",
  "CLIENT_BASE_URL",
  "CORS_ALLOWED_ORIGINS",
  "PORTAL_URL",
  "MAYA_URL",
  "MAYA_SERVICE_URL",
] as const;

function computeEnvData() {
  const missingRequired = requiredEnvKeys.filter((key) => !process.env[key]);
  const missingOptional = optionalEnvKeys.filter((key) => !process.env[key]);

  return {
    env: missingRequired.length === 0 ? "valid" : "invalid",
    valid: missingRequired.length === 0,
    missingRequired,
    missingOptional,
  };
}

router.get("/health", async (_req, res) => {
  const data = computeEnvData();
  const mayaUrl = process.env.MAYA_URL || process.env.MAYA_SERVICE_URL;
  let maya: "healthy" | "degraded" = "degraded";

  if (mayaUrl) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const resp = await fetch(`${mayaUrl}/health`, { signal: ctrl.signal });
      if (resp.ok) {
        const body = await resp.json().catch(() => ({}));
        if (body?.status === "ok") maya = "healthy";
      }
    } catch {
      // leave maya degraded
    } finally {
      clearTimeout(t);
    }
  }

  res.status(200).json({
    status: "ok",
    data: { ...data, maya },
  });
});

export default router;
