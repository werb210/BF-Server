export function ok(res, data = {}) {
    return res.status(200).json({
        status: "ok",
        data,
    });
}
export function error(res, message = "error", code = 500) {
    return res.status(code).json({
        status: "error",
        error: message,
    });
}
