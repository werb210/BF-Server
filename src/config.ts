import { ENV } from "./config/env";
import { logInfo } from "./observability/logger";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
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

const buildTimestampEnv = process.env.BUILD_TIMESTAMP;
const commitShaEnv = process.env.COMMIT_SHA;

if (buildTimestampEnv) {
  logInfo("build_timestamp", { buildTimestamp: buildTimestampEnv });
}

if (commitShaEnv) {
  logInfo("commit_sha", { commitSha: commitShaEnv });
}

/**
 * Optional build metadata.
 * These MUST NOT crash the server if missing.
 */
export const BUILD_TIMESTAMP = buildTimestampEnv ?? "unknown";
export const COMMIT_SHA = commitShaEnv ?? "unknown";

export function getBuildInfo(): { commitHash: string; buildTimestamp: string } {
  return {
    commitHash: COMMIT_SHA,
    buildTimestamp: BUILD_TIMESTAMP,
  };
}

/**
 * Runtime environment validation.
 * Only true runtime dependencies are enforced.
 */
export function assertEnv(): void {
  return;
}

export function getAccessTokenExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN ?? "15m";
}

export function getAccessTokenSecret(): string | undefined {
  return ENV.JWT_SECRET;
}

export function getRefreshTokenSecret(): string | undefined {
  return ENV.JWT_REFRESH_SECRET;
}

export function getRefreshTokenExpiresIn(): string {
  return process.env.JWT_REFRESH_EXPIRES_IN ?? "30d";
}

export function getRefreshTokenExpiresInMs(): number {
  return parsePositiveInt(process.env.JWT_REFRESH_EXPIRES_IN_MS, 30 * 24 * 60 * 60 * 1000);
}

export function getJwtClockSkewSeconds(): number {
  return parsePositiveInt(process.env.JWT_CLOCK_SKEW_SECONDS, 30);
}

export function getLoginLockoutThreshold(): number {
  return parsePositiveInt(process.env.LOGIN_LOCKOUT_THRESHOLD, 5);
}

export function getLoginLockoutMinutes(): number {
  return parsePositiveInt(process.env.LOGIN_LOCKOUT_MINUTES, 15);
}

export function getLoginTimeoutMs(): number {
  const configured = parsePositiveInt(process.env.LOGIN_TIMEOUT_MS, 5000);
  return Math.min(configured, 5000);
}

export function getPasswordMaxAgeDays(): number {
  return parsePositiveInt(process.env.PASSWORD_MAX_AGE_DAYS, 90);
}

export function getVoiceRestrictedNumbers(): string[] {
  return parseCsv(process.env.VOICE_RESTRICTED_NUMBERS, []);
}

export function getDocumentAllowedMimeTypes(): string[] {
  return parseCsv(process.env.DOCUMENT_ALLOWED_MIME_TYPES, [
    "application/pdf",
    "image/png",
    "image/jpeg",
  ]);
}

export function getDocumentMaxSizeBytes(): number {
  return parsePositiveInt(process.env.DOCUMENT_MAX_SIZE_BYTES, 10 * 1024 * 1024);
}

export function getClientSubmissionOwnerUserId(): string {
  return (
    process.env.CLIENT_SUBMISSION_OWNER_USER_ID ??
    "00000000-0000-0000-0000-000000000001"
  );
}

export function getReportingJobsEnabled(): boolean {
  return parseBoolean(process.env.REPORTING_JOBS_ENABLED, true);
}

export function getReportingDailyIntervalMs(): number {
  return parsePositiveInt(process.env.REPORTING_DAILY_INTERVAL_MS, 24 * 60 * 60 * 1000);
}

export function getReportingHourlyIntervalMs(): number {
  return parsePositiveInt(process.env.REPORTING_HOURLY_INTERVAL_MS, 60 * 60 * 1000);
}

export function getFollowUpJobsEnabled(): boolean {
  return parseBoolean(process.env.FOLLOWUP_JOBS_ENABLED, !ENV.TEST_MODE);
}

export function getFollowUpJobsIntervalMs(): number {
  return parsePositiveInt(process.env.FOLLOWUP_JOBS_INTERVAL_MS, 5 * 60 * 1000);
}

export function getOpsKillSwitchReplay(): boolean {
  return parseBoolean(process.env.OPS_KILL_SWITCH_REPLAY, false);
}

export function getOpsKillSwitchExports(): boolean {
  return parseBoolean(process.env.OPS_KILL_SWITCH_EXPORTS, false);
}

export function getOpsKillSwitchOcr(): boolean {
  return parseBoolean(process.env.OPS_KILL_SWITCH_OCR, false);
}

export function getOpsKillSwitchLenderTransmission(): boolean {
  return parseBoolean(process.env.OPS_KILL_SWITCH_LENDER_TRANSMISSION, false);
}

export function getLenderRetryBaseDelayMs(): number {
  return parsePositiveInt(process.env.LENDER_RETRY_BASE_DELAY_MS, 30_000);
}

export function getLenderRetryMaxDelayMs(): number {
  return parsePositiveInt(process.env.LENDER_RETRY_MAX_DELAY_MS, 5 * 60 * 1000);
}

export function getLenderRetryMaxCount(): number {
  return parsePositiveInt(process.env.LENDER_RETRY_MAX_COUNT, 5);
}

export function getRequestTimeoutMs(): number {
  return parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 10_000);
}

export function getOcrLockTimeoutMinutes(): number {
  return parsePositiveInt(process.env.OCR_LOCK_TIMEOUT_MINUTES, 15);
}

export function getOcrEnabled(): boolean {
  return parseBoolean(process.env.OCR_ENABLED, false);
}

export function getOcrPollIntervalMs(): number {
  return parsePositiveInt(process.env.OCR_POLL_INTERVAL_MS, 10_000);
}

export function getOcrWorkerConcurrency(): number {
  return parsePositiveInt(process.env.OCR_WORKER_CONCURRENCY, 2);
}

export function getOcrProvider(): string {
  return process.env.OCR_PROVIDER ?? "openai";
}

export function getOcrMaxAttempts(): number {
  return parsePositiveInt(process.env.OCR_MAX_ATTEMPTS, 3);
}

export function getOcrTimeoutMs(): number {
  return parsePositiveInt(process.env.OCR_TIMEOUT_MS, 30_000);
}

export function getVapidPublicKey(): string | undefined {
  return process.env.VAPID_PUBLIC_KEY;
}

export function getVapidPrivateKey(): string | undefined {
  return process.env.VAPID_PRIVATE_KEY;
}

export function getVapidSubject(): string | undefined {
  return process.env.VAPID_SUBJECT;
}

export function getPwaPushRateLimitMax(): number {
  return parsePositiveInt(process.env.PWA_PUSH_RATE_LIMIT_MAX, 20);
}

export function getPwaPushRateLimitWindowMs(): number {
  return parsePositiveInt(process.env.PWA_PUSH_RATE_LIMIT_WINDOW_MS, 60_000);
}

export function getPwaPushPayloadMaxBytes(): number {
  return parsePositiveInt(process.env.PWA_PUSH_MAX_BYTES, 4096);
}

export function getPwaSyncMaxActions(): number {
  return parsePositiveInt(process.env.PWA_SYNC_MAX_ACTIONS, 25);
}

export function getPwaSyncActionMaxBytes(): number {
  return parsePositiveInt(process.env.PWA_SYNC_ACTION_MAX_BYTES, 25_000);
}

export function getPwaSyncBatchMaxBytes(): number {
  return parsePositiveInt(process.env.PWA_SYNC_BATCH_MAX_BYTES, 100_000);
}

export function getOpenAiApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

export function getOpenAiOcrModel(): string {
  return process.env.OPENAI_OCR_MODEL ?? "gpt-4o-mini";
}

export function getLoginRateLimitMax(): number {
  return parsePositiveInt(process.env.LOGIN_RATE_LIMIT_MAX, 10);
}

export function getLoginRateLimitWindowMs(): number {
  return parsePositiveInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 60_000);
}

export function getRefreshRateLimitMax(): number {
  return parsePositiveInt(process.env.REFRESH_RATE_LIMIT_MAX, 15);
}

export function getRefreshRateLimitWindowMs(): number {
  return parsePositiveInt(process.env.REFRESH_RATE_LIMIT_WINDOW_MS, 60_000);
}

export function getPasswordResetRateLimitMax(): number {
  return parsePositiveInt(process.env.PASSWORD_RESET_RATE_LIMIT_MAX, 5);
}

export function getPasswordResetRateLimitWindowMs(): number {
  return parsePositiveInt(process.env.PASSWORD_RESET_RATE_LIMIT_WINDOW_MS, 15 * 60_000);
}

export function getDocumentUploadRateLimitMax(): number {
  return parsePositiveInt(process.env.DOCUMENT_UPLOAD_RATE_LIMIT_MAX, 20);
}

export function getDocumentUploadRateLimitWindowMs(): number {
  return parsePositiveInt(process.env.DOCUMENT_UPLOAD_RATE_LIMIT_WINDOW_MS, 60_000);
}

export function getClientSubmissionRateLimitMax(): number {
  return parsePositiveInt(process.env.CLIENT_SUBMISSION_RATE_LIMIT_MAX, 5);
}

export function getClientSubmissionRateLimitWindowMs(): number {
  return parsePositiveInt(process.env.CLIENT_SUBMISSION_RATE_LIMIT_WINDOW_MS, 60_000);
}

export function getLenderSubmissionRateLimitMax(): number {
  return parsePositiveInt(process.env.LENDER_SUBMISSION_RATE_LIMIT_MAX, 10);
}

export function getLenderSubmissionRateLimitWindowMs(): number {
  return parsePositiveInt(process.env.LENDER_SUBMISSION_RATE_LIMIT_WINDOW_MS, 60_000);
}

export function getAdminRateLimitMax(): number {
  return parsePositiveInt(process.env.ADMIN_RATE_LIMIT_MAX, 30);
}

export function getAdminRateLimitWindowMs(): number {
  return parsePositiveInt(process.env.ADMIN_RATE_LIMIT_WINDOW_MS, 60_000);
}

export function getCorsAllowlistConfig(): string[] {
  return [ENV.CLIENT_URL, ENV.PORTAL_URL].filter(Boolean);
}

export function getGlobalRateLimitWindowMsConfig(): number {
  return parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
}

export function getGlobalRateLimitMaxConfig(): number {
  return parsePositiveInt(process.env.RATE_LIMIT_MAX, 100);
}

export function getRateLimitEnabled(): boolean {
  if (process.env.ENABLE_RATE_LIMITING !== undefined) {
    return parseBoolean(process.env.ENABLE_RATE_LIMITING, !ENV.TEST_MODE);
  }
  return parseBoolean(process.env.RATE_LIMIT_ENABLED, !ENV.TEST_MODE);
}

export function getIdempotencyEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_IDEMPOTENCY, true);
}

export function getAuditHistoryEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AUDIT_HISTORY, true);
}

export function getRetryPolicyEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_RETRY_POLICY, true);
}

export function getAppInsightsConnectionStringConfig(): string {
  return process.env.APPINSIGHTS_CONNECTION_STRING ?? "";
}

export function isTestEnvironment(): boolean {
  return ENV.TEST_MODE;
}

export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

export function getRequestBodyLimit(): string {
  return process.env.REQUEST_BODY_LIMIT ?? "1mb";
}

export function getDbPoolMax(): number {
  return parsePositiveInt(process.env.DB_POOL_MAX, 10);
}

export function getDbPoolIdleTimeoutMs(): number {
  return parsePositiveInt(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30_000);
}

export function getDbPoolConnectionTimeoutMs(): number {
  const requestTimeoutMs = getRequestTimeoutMs();
  const configured = parsePositiveInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS, 10_000);
  if (configured < requestTimeoutMs) {
    return configured;
  }
  return Math.max(1, requestTimeoutMs - 100);
}

export function shouldRunMigrations(): boolean {
  return isProductionEnvironment() || process.env.RUN_MIGRATIONS === "true";
}


export function getAiModel(): string {
  return process.env.AI_MODEL ?? "gpt-4o-mini";
}

export function getAiEmbeddingModel(): string {
  return process.env.AI_EMBED_MODEL ?? "text-embedding-3-small";
}
