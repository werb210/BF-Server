export function requireString(v, name) {
    if (typeof v !== "string" || !v.trim()) {
        throw Object.assign(new Error(`INVALID_${name}`), { status: 400 });
    }
    return v.trim();
}
export function optionalString(v) {
    return typeof v === "string" ? v.trim() : undefined;
}
