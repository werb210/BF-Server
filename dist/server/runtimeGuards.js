export function assertRequiredEnv() {
    const required = ["PORT"];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.warn("Missing env vars:", missing.join(", "));
        return { ok: false, missing };
    }
    return { ok: true, missing: [] };
}
export function assertSingleServerStart() {
    if (global.__SERVER_STARTED__) {
        console.warn("SERVER_ALREADY_STARTED");
        return;
    }
    global.__SERVER_STARTED__ = true;
}
