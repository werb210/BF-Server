import { logError } from "../observability/logger";
import { validatePushEnvironmentAtStartup } from "../services/pushService";

const REQUIRED_ENV = [
  "DATABASE_URL",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_SECRET",
  "OPENAI_API_KEY",
] as const;

function getMissingEnvKeys(): string[] {
  return REQUIRED_ENV.filter((key) => {
    const value = process.env[key];
    return !value || value.trim().length === 0;
  });
}

export function assertRequiredAuthEnv(): void {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv !== "production") {
    return;
  }

  const missing = getMissingEnvKeys();
  if (missing.length === 0) {
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
