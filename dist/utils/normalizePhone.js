"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePhone = normalizePhone;
function normalizePhone(phone) {
    if (!phone)
        return "";
    // remove spaces, dashes, etc.
    phone = phone.replace(/[^\d+]/g, "");
    // ensure leading +
    if (!phone.startsWith("+")) {
        phone = "+" + phone;
    }
    return phone;
}
