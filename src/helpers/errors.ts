export type HttpishError = {
  status: number;
  message?: string;
  code?: string;
};

/**
 * Narrow check for HTTP-like errors.
 * Only accepts finite numeric status codes.
 */
export function isHttpishError(error: unknown): error is HttpishError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status);
}

/**
 * Extract a safe HTTP status code.
 * Defaults to 500 if invalid or out of range.
 */
export function fetchStatus(error: unknown): number {
  if (isHttpishError(error)) {
    const { status } = error;
    if (status >= 400 && status <= 599) {
      return status;
    }
  }
  return 500;
}
