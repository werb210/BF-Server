export async function retry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) {
        throw err;
      }
    }
  }

  throw new Error("retry_exhausted");
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  return retry(fn, attempts);
}

export async function withTimeout<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`operation_timed_out_after_${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function withRetryAndTimeout<T>(
  fn: () => Promise<T>,
  retries = 3,
  timeoutMs = 10_000
): Promise<T> {
  return withRetry(() => withTimeout(fn, timeoutMs), retries);
}
