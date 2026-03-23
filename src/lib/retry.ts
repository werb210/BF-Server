export async function retry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 200
): Promise<T> {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise(res => setTimeout(res, delay));
    }
  }

  throw lastError;
}
