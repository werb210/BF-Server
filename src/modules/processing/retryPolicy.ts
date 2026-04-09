import { AppError } from "../../middleware/errors.js";

export type RetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 1,
  baseDelayMs: 30_000,
};

export function computeRetryDelayMs(retryCount: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** Math.max(0, retryCount);
}

export function assertRetryAllowed(params: {
  retryCount: number;
  maxRetries: number;
  lastRetryAt: Date | null;
  baseDelayMs: number;
}): number {
  if (params.retryCount >= params.maxRetries) {
    throw new AppError("retry_exhausted", "Max retries reached.", 409);
  }
  const delay = computeRetryDelayMs(params.retryCount, params.baseDelayMs);
  if (!params.lastRetryAt) {
    return delay;
  }
  const elapsed = Date.now() - params.lastRetryAt.getTime();
  if (elapsed < delay) {
    throw new AppError(
      "retry_backoff",
      "Retry backoff window has not elapsed.",
      429
    );
  }
  return delay;
}
