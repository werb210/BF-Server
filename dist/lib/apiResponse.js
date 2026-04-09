export function ok(data) {
    return { status: "ok", data };
}
export function fail(_res, code, message) {
    return {
        status: "error",
        error: message ?? code,
    };
}
