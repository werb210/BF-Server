export function normalizePhone(phone) {
    if (!phone || phone.length < 10) {
        throw new Error("Invalid phone number");
    }
    return phone;
}
