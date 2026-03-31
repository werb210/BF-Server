export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  } = {}
): Promise<T> {
  const { retries = 3, baseDelayMs = 500, maxDelayMs = 5000 } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === retries) {
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
