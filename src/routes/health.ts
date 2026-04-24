import { Router } from "express";

const router = Router();

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

router.get("/", async (_req, res) => {
  const missingRequired = requiredEnvKeys.filter((key) => !process.env[key]);
  const missingOptional = optionalEnvKeys.filter((key) => !process.env[key]);

  const data = {
    env: missingRequired.length === 0 ? "valid" : "invalid",
    valid: missingRequired.length === 0,
    missingRequired,
    missingOptional,
  };

  let maya: "healthy" | "degraded" = "degraded";
  const mayaUrl = process.env.MAYA_URL || process.env.MAYA_SERVICE_URL;

  if (mayaUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
      const response = await fetch(`${mayaUrl}/health`, { signal: controller.signal });
      if (response.ok) {
        const body = await response.json();
        maya = body?.status === "ok" ? "healthy" : "degraded";
      }
    } catch {
      maya = "degraded";
    } finally {
      clearTimeout(timeout);
    }
  }

  res.status(200).json({
    status: "ok",
    data: { ...data, maya },
  });
});

export default router;
