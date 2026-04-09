export function normalizePhone(phone) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length !== 11 || !digits.startsWith("1")) {
        throw new Error("Invalid phone number");
    }
    return `+${digits}`;
}
export function normalizeOtpPhone(phone) {
    if (typeof phone !== "string") {
        return null;
    }
    try {
        const normalized = normalizePhone(phone);
        if (!normalized.startsWith("+")) {
            throw new Error("invalid_phone");
        }
        return normalized;
    }
    catch {
        return null;
    }
}
export function normalizePhoneNumber(phone) {
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
