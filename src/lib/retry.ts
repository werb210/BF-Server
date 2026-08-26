export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    // BF_SERVER_SMS_LOOP_KILL_v121 - permanent failures can stop immediately.
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const { retries = 3, baseDelayMs = 500, maxDelayMs = 5000, shouldRetry } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === retries) {
        break;
      }

      if (shouldRetry && !shouldRetry(error)) {
        break;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export async function retry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  return withRetry(fn, { retries });
}
