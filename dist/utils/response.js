export const ok = (data) => ({
    status: "ok",
    data,
});
export const fail = (error) => ({
    status: "error",
    error: {
        message: error,
    },
});
export function sendSuccess(res, data, code = 200) {
    return res.status(code).json(ok(data));
}
export function sendError(res, error, code = 500) {
    const normalized = typeof error === "string"
        ? { message: error }
        : { ...(error ?? {}), message: error?.message || "Unknown error" };
    return res.status(code).json({
        status: "error",
        error: normalized,
    });
}
