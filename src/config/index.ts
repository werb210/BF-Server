import { z } from "zod";
import { EnvSchema as LegacyEnvSchema } from "./schema";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.string().default("3000"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  REDIS_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE: z.string().optional(),
  SKIP_DB_CONNECTION: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  SLACK_ALERT_WEBHOOK_URL: z.string().optional(),
});

/* eslint-disable no-restricted-syntax */
const env = EnvSchema.parse(process.env);
const parsed = LegacyEnvSchema.parse(process.env as Record<string, string | undefined>);
/* eslint-enable no-restricted-syntax */

const toNumber = (value: string | undefined, fallback: number): number => {
  const candidate = value ?? "";
  if (!candidate) return fallback;
  const parsedNumber = Number(candidate);
  return Number.isFinite(parsedNumber) ? parsedNumber : fallback;
};

const toBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const csv = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) return fallback;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

export const config = Object.freeze({
  env: env.NODE_ENV,
  port: Number(env.PORT),
  logLevel: parsed.LOG_LEVEL,
  commitSha: parsed.COMMIT_SHA ?? "unknown",
  buildTimestamp: parsed.BUILD_TIMESTAMP ?? new Date(0).toISOString(),

  api: Object.freeze({
    baseUrl: parsed.API_BASE_URL,
  }),
  app: Object.freeze({
    baseUrl: parsed.BASE_URL,
    testMode: parsed.TEST_MODE,
  }),
  auth: Object.freeze({
    jwtSecret: env.JWT_SECRET,
    debugOtpPhone: parsed.AUTH_DEBUG_OTP_PHONE,
    otpHashSalt: parsed.OTP_HASH_SALT,
    testOtpCode: parsed.TEST_OTP_CODE,
    refreshSecret: parsed.JWT_REFRESH_SECRET,
    accessExpiresIn: parsed.JWT_ACCESS_EXPIRES_IN ?? "1h",
    refreshExpiresMs: toNumber(parsed.JWT_REFRESH_EXPIRES_MS, 7 * 24 * 60 * 60 * 1000),
    jwtClockSkewSeconds: toNumber(parsed.JWT_CLOCK_SKEW_SECONDS, 0),
  }),
  azureOpenai: Object.freeze({
    deployment: parsed.AZURE_OPENAI_DEPLOYMENT,
    endpoint: parsed.AZURE_OPENAI_ENDPOINT,
    key: parsed.AZURE_OPENAI_KEY,
  }),
  azureStorage: Object.freeze({
    connectionString: parsed.AZURE_STORAGE_CONNECTION_STRING,
  }),
  bootstrap: Object.freeze({
    adminPhone: parsed.BOOTSTRAP_ADMIN_PHONE,
  }),
  client: Object.freeze({
    url: parsed.CLIENT_URL,
    submissionOwnerUserId: parsed.CLIENT_SUBMISSION_OWNER_USER_ID ?? null,
  }),
  codespaces: Object.freeze({
    enabled: parsed.CODESPACES,
    name: parsed.CODESPACE_NAME,
    portForwardingDomain: parsed.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN,
  }),
  cors: Object.freeze({
    allowedOrigins: parsed.CORS_ALLOWED_ORIGINS,
  }),
  crm: Object.freeze({
    webhookUrl: parsed.CRM_WEBHOOK_URL,
  }),
  db: Object.freeze({
    url: env.DATABASE_URL,
    skip: env.SKIP_DB_CONNECTION === "true",
    host: parsed.DB_HOST,
    ssl: parsed.DB_SSL,
  }),
  database: Object.freeze({
    url: env.DATABASE_URL,
  }),
  documents: Object.freeze({
    maxSizeBytes: toNumber(parsed.DOCUMENT_MAX_SIZE_BYTES, 10 * 1024 * 1024),
    allowedMimeTypes: csv(parsed.DOCUMENT_ALLOWED_MIME_TYPES, ["application/pdf", "image/jpeg", "image/png"]),
  }),
  followUp: Object.freeze({
    intervalMs: toNumber(parsed.FOLLOW_UP_INTERVAL_MS, 60_000),
    enabled: toBool(parsed.FOLLOW_UP_ENABLED, true),
  }),
  google: Object.freeze({
    clientId: parsed.GOOGLE_CLIENT_ID,
    clientSecret: parsed.GOOGLE_CLIENT_SECRET,
    redirectUri: parsed.GOOGLE_REDIRECT_URI,
    refreshToken: parsed.GOOGLE_SHEETS_REFRESH_TOKEN,
    serviceAccountEmail: parsed.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    serviceAccountPrivateKey: parsed.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  }),
  intake: Object.freeze({
    smsNumber: parsed.INTAKE_SMS_NUMBER,
  }),
  internal: Object.freeze({
    apiKey: parsed.INTERNAL_API_KEY,
    enableTestRoutes: parsed.ENABLE_INT_TEST_ROUTES,
  }),
  jwt: Object.freeze({
    secret: parsed.JWT_SECRET,
  }),
  lender: Object.freeze({
    retry: Object.freeze({
      baseDelayMs: toNumber(parsed.LENDER_RETRY_BASE_DELAY_MS, 500),
      maxDelayMs: toNumber(parsed.LENDER_RETRY_MAX_DELAY_MS, 5_000),
      maxCount: toNumber(parsed.LENDER_RETRY_MAX_COUNT, 3),
    }),
  }),
  openai: Object.freeze({
    apiKey: env.OPENAI_API_KEY,
    chatModel: parsed.OPENAI_CHAT_MODEL,
    embedModel: parsed.OPENAI_EMBED_MODEL,
    model: env.OPENAI_MODEL,
    ocrModel: parsed.OPENAI_OCR_MODEL ?? "gpt-4o-mini",
  }),
  ai: Object.freeze({
    embedModel: parsed.AI_EMBED_MODEL,
    embeddingModel: parsed.AI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    model: parsed.AI_MODEL ?? "gpt-4o-mini",
    systemName: parsed.AI_SYSTEM_NAME,
  }),
  ocr: Object.freeze({
    enabled: toBool(parsed.OCR_ENABLED, true),
    provider: parsed.OCR_PROVIDER ?? "openai",
    timeoutMs: toNumber(parsed.OCR_TIMEOUT_MS, 30_000),
    maxAttempts: toNumber(parsed.OCR_MAX_ATTEMPTS, 3),
    pollIntervalMs: toNumber(parsed.OCR_POLL_INTERVAL_MS, 5_000),
    workerConcurrency: toNumber(parsed.OCR_WORKER_CONCURRENCY, 2),
    lockTimeoutMinutes: toNumber(parsed.OCR_LOCK_TIMEOUT_MINUTES, 30),
  }),
  portal: Object.freeze({
    url: parsed.PORTAL_URL,
  }),
  pwa: Object.freeze({
    pushEnabled: parsed.PWA_PUSH_ENABLED,
    syncMaxActions: toNumber(parsed.PWA_SYNC_MAX_ACTIONS, 100),
    syncActionMaxBytes: toNumber(parsed.PWA_SYNC_ACTION_MAX_BYTES, 16_384),
    syncBatchMaxBytes: toNumber(parsed.PWA_SYNC_BATCH_MAX_BYTES, 262_144),
    pushPayloadMaxBytes: toNumber(parsed.PWA_PUSH_PAYLOAD_MAX_BYTES, 4096),
  }),
  rateLimit: Object.freeze({
    enabled: parsed.RATE_LIMIT_ENABLED,
    windowMs: toNumber(parsed.RATE_LIMIT_WINDOW_MS, 60_000),
    max: toNumber(parsed.RATE_LIMIT_MAX, 100),
  }),
  redis: Object.freeze({
    url: env.REDIS_URL ?? "",
  }),
  twilio: Object.freeze({
    sid: env.TWILIO_ACCOUNT_SID ?? "",
    token: env.TWILIO_AUTH_TOKEN ?? "",
    phone: env.TWILIO_PHONE,
    accountSid: env.TWILIO_ACCOUNT_SID ?? "",
    apiKey: parsed.TWILIO_API_KEY,
    apiSecret: parsed.TWILIO_API_SECRET,
    authToken: env.TWILIO_AUTH_TOKEN ?? "",
    from: parsed.TWILIO_FROM,
    number: parsed.TWILIO_NUMBER,
    phoneNumber: parsed.TWILIO_PHONE_NUMBER,
    verifyServiceSid: parsed.TWILIO_VERIFY_SERVICE_SID,
    voiceAppSid: parsed.TWILIO_VOICE_APP_SID,
  }),
  allowedOrigins: parsed.ALLOWED_ORIGINS,
  website: Object.freeze({
    url: parsed.WEBSITE_URL,
  }),
  urls: Object.freeze({
    apiBase: parsed.API_BASE_URL,
    publicBase: parsed.PUBLIC_BASE_URL,
    clientBase: parsed.CLIENT_BASE_URL,
  }),
  sentry: Object.freeze({
    dsn: env.SENTRY_DSN,
  }),
  alerting: Object.freeze({
    slackWebhookUrl: env.SLACK_ALERT_WEBHOOK_URL,
  }),
  telemetry: Object.freeze({
    instanceId: parsed.INSTANCE_ID ?? parsed.HOSTNAME ?? "unknown",
    appInsightsConnectionString:
      parsed.APPINSIGHTS_CONNECTION_STRING ?? parsed.APPLICATIONINSIGHTS_CONNECTION_STRING,
  }),
  flags: Object.freeze({
    allowUnfrozenApiV1: parsed.API_V1_ALLOW_UNFROZEN === "true",
    runDbMigrations: parsed.RUN_DB_MIGRATIONS === "true",
    skipDbConnection: env.SKIP_DB_CONNECTION === "true",
    idempotencyEnabled: toBool(parsed.IDEMPOTENCY_ENABLED, false),
    auditHistoryEnabled: toBool(parsed.AUDIT_HISTORY_ENABLED, false),
    retryPolicyEnabled: toBool(parsed.RETRY_POLICY_ENABLED, true),
    reportingJobsEnabled: toBool(parsed.REPORTING_JOBS_ENABLED, true),
    reportingDailyIntervalMs: toNumber(parsed.REPORTING_DAILY_INTERVAL_MS, 24 * 60 * 60 * 1000),
    reportingHourlyIntervalMs: toNumber(parsed.REPORTING_HOURLY_INTERVAL_MS, 60 * 60 * 1000),
    opsKillSwitchReplay: toBool(parsed.OPS_KILL_SWITCH_REPLAY, false),
    opsKillSwitchExports: toBool(parsed.OPS_KILL_SWITCH_EXPORTS, false),
    opsKillSwitchOcr: toBool(parsed.OPS_KILL_SWITCH_OCR, false),
    opsKillSwitchLenderTransmission: toBool(parsed.OPS_KILL_SWITCH_LENDER_TRANSMISSION, false),
  }),
  runtime: Object.freeze({
    isProd: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
  }),
  features: Object.freeze({
    ocrEnabled: toBool(parsed.OCR_ENABLED, true),
  }),
  security: Object.freeze({
    otpHashSecret: parsed.OTP_HASH_SECRET,
    vapidPublicKey: parsed.VAPID_PUBLIC_KEY ?? "",
    vapidPrivateKey: parsed.VAPID_PRIVATE_KEY ?? "",
    vapidSubject: parsed.VAPID_SUBJECT,
    voiceRestrictedNumbers: csv(parsed.VOICE_RESTRICTED_NUMBERS, []),
  }),
  isProduction: env.NODE_ENV === "production",
});
/* eslint-disable no-restricted-syntax */
export const ENV = process.env as Record<string, string | undefined>;
/* eslint-enable no-restricted-syntax */

export const validateServerEnv = (): void => {
  if (!config.db.url) throw new Error("DATABASE_URL missing");
};

export const assertEnv = validateServerEnv;
export const COMMIT_SHA = config.commitSha;

export type Config = typeof config;
