import { ENV } from './config/env';

// --- CORE ENV HELPERS ---

export function assertEnv(): void {
  if (!ENV.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
}

export function isProductionEnvironment(): boolean {
  return ENV.NODE_ENV === 'production';
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

// --- UPLOADS ---

export function getDocumentMaxSizeBytes(): number {
  return 10 * 1024 * 1024; // 10MB
}

export function getDocumentAllowedMimeTypes(): string[] {
  return ['application/pdf', 'image/png', 'image/jpeg'];
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

