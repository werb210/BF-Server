import dotenv from "dotenv";
import { logError, logWarn } from "../observability/logger";

dotenv.config();

const REQUIRED = [
  "DATABASE_URL",
  "JWT_SECRET",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "SENDGRID_API_KEY",
] as const;

export function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

const requiredRuntimeEnv = [
  "NODE_ENV",
  "DATABASE_URL",
  "CORS_ALLOWED_ORIGINS",
  "RATE_LIMIT_WINDOW_MS",
  "RATE_LIMIT_MAX",
  "APPINSIGHTS_CONNECTION_STRING",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "JWT_EXPIRES_IN",
  "JWT_REFRESH_EXPIRES_IN",
] as const;

type EnvConfig = {
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtRefreshSecret: string;
  corsAllowlist: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  appInsightsConnectionString: string;
  jwtExpiresIn: string;
  jwtRefreshExpiresIn: string;
  jwtRefreshExpiresInMs: number;
  jwtClockSkewSeconds: number;
};

let cachedEnv: EnvConfig | null = null;

export const IS_TEST = process.env.NODE_ENV === "test";

export function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test";
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

function getEnvValue(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export function getAccessTokenSecret(): string | undefined {
  return getEnvValue("JWT_SECRET");
}

export function getRefreshTokenSecret(): string | undefined {
  return getEnvValue("JWT_REFRESH_SECRET");
}

function parsePositiveInt(value: string | undefined, fallback?: number): number {
  if (!value) {
    return fallback ?? 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback ?? 0;
  }
  return Math.floor(parsed);
}

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseRequiredPositiveInt(value: string | undefined, label: string): number {
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return Math.floor(parsed);
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : fallback;
}

function parseDurationToMs(value: string | undefined, label: string): number {
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)(ms|s|m|h|d)?$/i);
  if (!match) {
    throw new Error(`${label} must be a duration like 15m, 1h, or 30d.`);
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive duration.`);
  }
  const unit = (match[2] ?? "s").toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const multiplier = multipliers[unit];
  if (!multiplier) {
    throw new Error(`${label} must use ms, s, m, h, or d.`);
  }
  return amount * multiplier;
}

export function assertEnv(): void {
  if (isTestEnv()) {
    return;
  }
  const missing: string[] = requiredRuntimeEnv.filter(
    (key) => !getEnvValue(key)
  );
  if (isProductionEnv() && !getEnvValue("BASE_URL")) {
    missing.push("BASE_URL");
  }
  if (missing.length > 0) {
    if (!isProductionEnv()) {
      logWarn("missing_env_non_production", { keys: missing });
      return;
    }

    logError("missing_env", { keys: missing });
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const optionalServices = [
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
  ];

  optionalServices.forEach((service) => {
    const missingKeys = service.keys.filter((key) => !getEnvValue(key));
    if (missingKeys.length > 0) {
      logWarn("optional_service_disabled", {
        service: service.name,
        missing: missingKeys,
      });
    }
  });

  const allowlist = parseCsv(
    getEnvValue("CORS_ALLOWED_ORIGINS") ?? getEnvValue("CORS_ALLOWLIST"),
    []
  );
  if (allowlist.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS must include at least one origin.");
  }
  if (allowlist.includes("*")) {
    throw new Error("CORS_ALLOWED_ORIGINS must not include wildcard entries.");
  }

  parseRequiredPositiveInt(getEnvValue("RATE_LIMIT_WINDOW_MS"), "RATE_LIMIT_WINDOW_MS");
  parseRequiredPositiveInt(getEnvValue("RATE_LIMIT_MAX"), "RATE_LIMIT_MAX");
  parseDurationToMs(getEnvValue("JWT_EXPIRES_IN"), "JWT_EXPIRES_IN");
  parseDurationToMs(getEnvValue("JWT_REFRESH_EXPIRES_IN"), "JWT_REFRESH_EXPIRES_IN");
}

export function getEnvConfig(): EnvConfig {
  const currentNodeEnv = getEnvValue("NODE_ENV") ?? "";
  const shouldCache = currentNodeEnv.length > 0 && !isTestEnv();
  if (shouldCache && cachedEnv && cachedEnv.nodeEnv === currentNodeEnv) {
    return cachedEnv;
  }

  const treatAsTest = isTestEnv();

  if (currentNodeEnv && !isTestEnv()) {
    assertEnv();
  }

  const testDefaults = {
    corsAllowlist: ["*"],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    appInsightsConnectionString: "",
    jwtExpiresIn: "15m",
    jwtRefreshExpiresIn: "30d",
    jwtClockSkewSeconds: 60,
  };

  const nodeEnv = getEnvValue("NODE_ENV") ?? (treatAsTest ? "test" : "");
  const databaseUrl = getEnvValue("DATABASE_URL") ?? (treatAsTest ? "" : "");
  const jwtSecret = getAccessTokenSecret() ?? (treatAsTest ? "test" : "");
  const jwtRefreshSecret =
    getRefreshTokenSecret() ?? (treatAsTest ? "test-refresh" : "");
  const corsAllowlist = parseCsv(
    getEnvValue("CORS_ALLOWED_ORIGINS") ?? getEnvValue("CORS_ALLOWLIST"),
    testDefaults.corsAllowlist
  );
  if (!treatAsTest && corsAllowlist.includes("*")) {
    logWarn("cors_allowlist_fallback", { corsAllowlist });
  }
  const rateLimitWindowMs = parsePositiveInt(
    getEnvValue("RATE_LIMIT_WINDOW_MS"),
    testDefaults.rateLimitWindowMs
  );
  const rateLimitMax = parsePositiveInt(
    getEnvValue("RATE_LIMIT_MAX"),
    testDefaults.rateLimitMax
  );
  const appInsightsConnectionString =
    getEnvValue("APPINSIGHTS_CONNECTION_STRING") ??
    (treatAsTest ? testDefaults.appInsightsConnectionString : "");
  const jwtExpiresIn = getEnvValue("JWT_EXPIRES_IN") ?? testDefaults.jwtExpiresIn;
  const jwtRefreshExpiresIn =
    getEnvValue("JWT_REFRESH_EXPIRES_IN") ?? testDefaults.jwtRefreshExpiresIn;
  const jwtRefreshExpiresInMs = parseDurationToMs(
    jwtRefreshExpiresIn,
    "JWT_REFRESH_EXPIRES_IN"
  );
  const jwtClockSkewSeconds = parseNonNegativeInt(
    getEnvValue("JWT_CLOCK_SKEW_SECONDS"),
    testDefaults.jwtClockSkewSeconds
  );

  const config: EnvConfig = {
    nodeEnv,
    databaseUrl,
    jwtSecret,
    jwtRefreshSecret,
    corsAllowlist,
    rateLimitWindowMs,
    rateLimitMax,
    appInsightsConnectionString,
    jwtExpiresIn,
    jwtRefreshExpiresIn,
    jwtRefreshExpiresInMs,
    jwtClockSkewSeconds,
  };

  if (shouldCache) {
    cachedEnv = config;
  }

  return config;
}

export function resetEnvConfig(): void {
  cachedEnv = null;
}

export function getCorsAllowlist(): string[] {
  return getEnvConfig().corsAllowlist;
}

export function getGlobalRateLimitWindowMs(): number {
  return getEnvConfig().rateLimitWindowMs;
}

export function getGlobalRateLimitMax(): number {
  return getEnvConfig().rateLimitMax;
}

export function getJwtExpiresIn(): string {
  return getEnvConfig().jwtExpiresIn;
}

export function getJwtRefreshExpiresIn(): string {
  return getEnvConfig().jwtRefreshExpiresIn;
}

export function getJwtRefreshExpiresInMs(): number {
  return getEnvConfig().jwtRefreshExpiresInMs;
}

export function getJwtClockSkewSeconds(): number {
  return getEnvConfig().jwtClockSkewSeconds;
}

export function getAppInsightsConnectionString(): string {
  return getEnvConfig().appInsightsConnectionString;
}
