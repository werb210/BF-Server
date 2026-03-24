let failureCount = 0;
let lastFailureTime = 0;

const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT = 30000; // 30s

export function canExecute(): boolean {
  if (failureCount < FAILURE_THRESHOLD) return true;

  const now = Date.now();
  if (now - lastFailureTime > RESET_TIMEOUT) {
    failureCount = 0;
    return true;
  }

  return false;
}

export function recordFailure() {
  failureCount++;
  lastFailureTime = Date.now();
}

export async function safeCall<T>(fn: () => Promise<T>): Promise<T> {
  if (!canExecute()) {
    throw new Error("Service unavailable");
  }

  try {
    const result = await fn();
    failureCount = 0;
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}
