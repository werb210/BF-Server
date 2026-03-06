import { logError, logWarn } from "../observability/logger";
import { validatePushEnvironmentAtStartup } from "../services/pushService";

const REQUIRED_AUTH_ENV = [
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
] as const;

const OPTIONAL_SERVICE_ENV = [
  {
    name: "twilio_verify",
    keys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID"],
  },
  {
    name: "twilio_voice",
    keys: [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_API_KEY",
      "TWILIO_API_SECRET",
      "TWILIO_VOICE_APP_SID",
      "TWILIO_VOICE_CALLER_ID",
    ],
  },
] as const;

function getMissingEnvKeys(): string[] {
  return REQUIRED_AUTH_ENV.filter((key) => {
    const value = process.env[key];
    return !value || value.trim().length === 0;
  });
}

export function assertRequiredAuthEnv(): void {
  const nodeEnv = process.env.NODE_ENV ?? "";
  if (nodeEnv === "development" || nodeEnv === "test") {
    return;
  }
  const missing = getMissingEnvKeys();
  if (missing.length === 0) {
    OPTIONAL_SERVICE_ENV.forEach((service) => {
      const missingKeys = service.keys.filter((key) => {
        const value = process.env[key];
        return !value || value.trim().length === 0;
      });
      if (missingKeys.length > 0) {
        logWarn("optional_service_disabled", {
          service: service.name,
          missing: missingKeys,
        });
      }
    });
    return;
  }

  missing.forEach((key) => {
    logError("missing_env", { key });
  });

  throw new Error(
    `Missing required environment variables: ${missing.join(", ")}`
  );
}

assertRequiredAuthEnv();


validatePushEnvironmentAtStartup();
