export function toStringSet(val) {
    if (Array.isArray(val))
        return new Set(val.map((item) => String(item)));
    if (val == null)
        return new Set();
    return new Set([String(val)]);
}
