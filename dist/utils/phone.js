export function normalizePhone(phone) {
    if (typeof phone !== "string") {
        throw new Error("Invalid phone number format");
    }
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 10) {
        return `+1${digits}`;
    }
    if (digits.length === 11 && digits.startsWith("1")) {
        return `+${digits}`;
    }
    throw new Error("Invalid phone number format");
}
export function tryNormalizePhone(phone) {
    if (typeof phone !== "string") {
        return null;
    }
    try {
        return normalizePhone(phone);
    }
    catch {
        return null;
    }
}
