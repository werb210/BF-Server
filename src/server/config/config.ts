import { env } from "../../platform/env";
import type { AppConfig } from "./config.schema";

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const csv = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) return fallback;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
};

export const config: AppConfig = {
  auth: {
    jwtSecret: env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? "dev-refresh-secret",
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? "1h",
    refreshExpiresMs: toNumber(process.env.JWT_REFRESH_EXPIRES_MS, 7 * 24 * 60 * 60 * 1000),
  },
  documents: {
    maxSizeBytes: toNumber(process.env.DOCUMENT_MAX_SIZE_BYTES, 10 * 1024 * 1024),
    allowedMimeTypes: csv(process.env.DOCUMENT_ALLOWED_MIME_TYPES, ["application/pdf", "image/jpeg", "image/png"]),
  },
  ocr: { timeoutMs: toNumber(process.env.OCR_TIMEOUT_MS, 30_000) },
  lender: {
    retry: {
      baseDelayMs: toNumber(process.env.LENDER_RETRY_BASE_DELAY_MS, 500),
      maxDelayMs: toNumber(process.env.LENDER_RETRY_MAX_DELAY_MS, 5_000),
      maxCount: toNumber(process.env.LENDER_RETRY_MAX_COUNT, 3),
    },
  },
  followUp: {
    intervalMs: toNumber(process.env.FOLLOW_UP_INTERVAL_MS, 60_000),
    enabled: toBool(process.env.FOLLOW_UP_ENABLED, true),
  },
  rateLimit: {
    windowMs: toNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: toNumber(process.env.RATE_LIMIT_MAX, 100),
  },
  client: { submissionOwnerUserId: process.env.CLIENT_SUBMISSION_OWNER_USER_ID ?? null },
};

export const runtimeEnv = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test" || process.env.TEST_MODE === "true",
  commitSha: process.env.COMMIT_SHA ?? "unknown",
  buildTimestamp: process.env.BUILD_TIMESTAMP ?? new Date(0).toISOString(),
  idempotencyEnabled: toBool(process.env.IDEMPOTENCY_ENABLED, false),
  auditHistoryEnabled: toBool(process.env.AUDIT_HISTORY_ENABLED, false),
  jwtClockSkewSeconds: toNumber(process.env.JWT_CLOCK_SKEW_SECONDS, 0),
  aiModel: process.env.AI_MODEL ?? "gpt-4o-mini",
  aiEmbeddingModel: process.env.AI_EMBEDDING_MODEL ?? "text-embedding-3-small",
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  openAiOcrModel: process.env.OPENAI_OCR_MODEL ?? "gpt-4o-mini",
  ocrEnabled: toBool(process.env.OCR_ENABLED, true),
  ocrProvider: process.env.OCR_PROVIDER ?? "openai",
  ocrMaxAttempts: toNumber(process.env.OCR_MAX_ATTEMPTS, 3),
  ocrPollIntervalMs: toNumber(process.env.OCR_POLL_INTERVAL_MS, 5_000),
  ocrWorkerConcurrency: toNumber(process.env.OCR_WORKER_CONCURRENCY, 2),
  ocrLockTimeoutMinutes: toNumber(process.env.OCR_LOCK_TIMEOUT_MINUTES, 30),
  pwaSyncMaxActions: toNumber(process.env.PWA_SYNC_MAX_ACTIONS, 100),
  pwaSyncActionMaxBytes: toNumber(process.env.PWA_SYNC_ACTION_MAX_BYTES, 16_384),
  pwaSyncBatchMaxBytes: toNumber(process.env.PWA_SYNC_BATCH_MAX_BYTES, 262_144),
  pwaPushPayloadMaxBytes: toNumber(process.env.PWA_PUSH_PAYLOAD_MAX_BYTES, 4096),
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:dev@example.com",
  retryPolicyEnabled: toBool(process.env.RETRY_POLICY_ENABLED, true),
  reportingJobsEnabled: toBool(process.env.REPORTING_JOBS_ENABLED, true),
  reportingDailyIntervalMs: toNumber(process.env.REPORTING_DAILY_INTERVAL_MS, 24 * 60 * 60 * 1000),
  reportingHourlyIntervalMs: toNumber(process.env.REPORTING_HOURLY_INTERVAL_MS, 60 * 60 * 1000),
  voiceRestrictedNumbers: csv(process.env.VOICE_RESTRICTED_NUMBERS, []),
  opsKillSwitchReplay: toBool(process.env.OPS_KILL_SWITCH_REPLAY, false),
  opsKillSwitchExports: toBool(process.env.OPS_KILL_SWITCH_EXPORTS, false),
  opsKillSwitchOcr: toBool(process.env.OPS_KILL_SWITCH_OCR, false),
  opsKillSwitchLenderTransmission: toBool(process.env.OPS_KILL_SWITCH_LENDER_TRANSMISSION, false),
};

export const ENV = process.env;
export const COMMIT_SHA = runtimeEnv.commitSha;

export const validateServerEnv = (): void => { if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing"); };
export const assertEnv = validateServerEnv;

export default config;
