export async function withRetry(fn, options = {}) {
    const { retries = 3, baseDelayMs = 500, maxDelayMs = 5000 } = options;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await fn();
        }
        catch (error) {
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
export async function retry(fn, retries = 3) {
    return withRetry(fn, { retries });
}
