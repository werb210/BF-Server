import { ENV } from './config/env';

// --- ENV BASICS ---

export function assertEnv(): void {
  if (!ENV.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
}

export function isProductionEnvironment(): boolean {
  return ENV.NODE_ENV === 'production';
}

export function isTestEnvironment(): boolean {
  return ENV.TEST_MODE === 'true';
}

export function getTestMode(): boolean {
  return ENV.TEST_MODE === 'true';
}

// --- JWT ---

export function getAccessTokenSecret(): string {
  return ENV.JWT_SECRET || 'dev-secret';
}

export function getRefreshTokenSecret(): string {
  return ENV.JWT_REFRESH_SECRET || 'dev-refresh-secret';
}

export function getAccessTokenExpiresIn(): string {
  return '1h';
}

export function getRefreshTokenExpiresInMs(): number {
  return 7 * 24 * 60 * 60 * 1000;
}

export function getJwtClockSkewSeconds(): number {
  return 0;
}

// --- URLS ---

export function getPortalUrl(): string {
  return ENV.PORTAL_URL || '';
}

export function getClientUrl(): string {
  return ENV.CLIENT_URL || '';
}

// --- AI ---

export function getAiModel(): string {
  return 'gpt-4';
}

export function getAiEmbeddingModel(): string {
  return 'text-embedding-3-small';
}

// --- FILES ---

export function getDocumentMaxSizeBytes(): number {
  return 10 * 1024 * 1024;
}

export function getDocumentAllowedMimeTypes(): string[] {
  return ['application/pdf', 'image/png', 'image/jpeg'];
}

// --- BUSINESS LOGIC ---

export function getFollowUpJobsEnabled(): boolean {
  return true;
}

export function getClientSubmissionOwnerUserId(): string {
  return 'system';
}

// --- IDEMPOTENCY ---

export function getIdempotencyEnabled(): boolean {
  return true;
}

// --- RATE LIMIT ---

export function getRateLimitMax(): number {
  return parseInt(ENV.RATE_LIMIT_MAX || '100', 10);
}

export function getRateLimitWindowMs(): number {
  return parseInt(ENV.RATE_LIMIT_WINDOW_MS || '900000', 10);
}

export function getFollowUpJobsIntervalMs(): number {
  return 5 * 60 * 1000; // 5 minutes
}

// --- LENDER RETRY CONFIG ---

export function getLenderRetryBaseDelayMs(): number {
  return 1000;
}

export function getLenderRetryMaxDelayMs(): number {
  return 30000;
}

export function getLenderRetryMaxCount(): number {
  return 3;
}

// -------- OCR CONFIG --------

export function getOcrEnabled(): boolean {
  return true;
}

export function getOcrProvider(): string {
  return 'openai';
}

export function getOcrPollIntervalMs(): number {
  return 5000;
}

export function getOcrMaxAttempts(): number {
  return 5;
}

export function getOcrLockTimeoutMinutes(): number {
  return 10;
}

export function getOcrTimeoutMs(): number {
  return 30000;
}

export function getOpenAiOcrModel(): string {
  return 'gpt-4o-mini';
}

export function getOpenAiApiKey(): string {
  return process.env.OPENAI_API_KEY || '';
}

// -------- REPORTING --------

export function getReportingDailyIntervalMs(): number {
  return 24 * 60 * 60 * 1000; // daily
}

// -------- RETRY POLICY --------

export function getRetryPolicyEnabled(): boolean {
  return true;
}

// -------- OPS KILL SWITCHES --------

export function getOpsKillSwitchReplay(): boolean {
  return false;
}

export function getOpsKillSwitchOcr(): boolean {
  return false;
}

export function getOpsKillSwitchLenderTransmission(): boolean {
  return false;
}

export function getOpsKillSwitchExports(): boolean {
  return false;
}

// -------- OCR WORKER --------

export function getOcrWorkerConcurrency(): number {
  return 2;
}

// -------- REPORTING JOBS --------

export function getReportingJobsEnabled(): boolean {
  return true;
}

export function getReportingHourlyIntervalMs(): number {
  return 60 * 60 * 1000; // hourly
}

// -------- META --------

export const COMMIT_SHA = process.env.COMMIT_SHA || 'dev';

// -------- VOICE --------

export function getVoiceRestrictedNumbers(): string[] {
  return [];
}

// -------- BUILD --------

export function getBuildInfo() {
  return {
    commit: process.env.COMMIT_SHA || 'dev',
    env: process.env.NODE_ENV || 'dev'
  };
}
