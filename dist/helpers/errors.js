/**
 * Narrow check for HTTP-like errors.
 * Only accepts finite numeric status codes.
 */
export function isHttpishError(error) {
    if (typeof error !== "object" || error === null) {
        return false;
    }
    const status = error.status;
    return typeof status === "number" && Number.isFinite(status);
}
/**
 * Extract a safe HTTP status code.
 * Defaults to 500 if invalid or out of range.
 */
export function fetchStatus(error) {
    if (isHttpishError(error)) {
        const { status } = error;
        if (status >= 400 && status <= 599) {
            return status;
        }
    }
    return 500;
}
