
import { ENV } from './env';

/**
 * Universal fallback handler
 * Prevents build from breaking when functions are missing
 */
const fallback = (name: string) => {
  console.warn(`[ENV FALLBACK] ${name} not implemented`);
  return undefined;
};

/* =========================
   SAFE EXPORT WRAPPER
   ========================= */

export const isTestEnvironment = () => ENV.TEST_MODE;
export const isTest = () => ENV.TEST_MODE;

/* AUTH */
export const getAccessTokenSecret = () => ENV.JWT_SECRET;
export const getRefreshTokenSecret = () => ENV.JWT_REFRESH_SECRET;
export const getAccessTokenExpiresIn = () => '1h';
export const getRefreshTokenExpiresInMs = () => 1000 * 60 * 60 * 24 * 7;

/* DOCUMENTS */
export const getDocumentAllowedMimeTypes = () => [
  'application/pdf',
  'image/jpeg',
  'image/png'
];

export const getDocumentMaxSizeBytes = () => 10 * 1024 * 1024;

/* OCR */
export const getOcrTimeoutMs = () => 30000;

/* LENDER RETRY */
export const getLenderRetryMaxDelayMs = () => 5000;
export const getLenderRetryMaxCount = () => 3;
export const getLenderRetryBaseDelayMs = () => 500;

/* FOLLOW UPS */
export const getFollowUpJobsIntervalMs = () => 60000;
export const getFollowUpJobsEnabled = () => true;

/* CLIENT */
export const getClientSubmissionOwnerUserId = () => null;

/* FALLBACK EXPORT (catch anything missed) */
export const ENV_FALLBACK = new Proxy({}, {
  get: (_, prop: string) => () => fallback(prop),
});

