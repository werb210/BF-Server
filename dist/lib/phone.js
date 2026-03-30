"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePhone = normalizePhone;
function normalizePhone(phone) {
    if (!phone || phone.length < 10) {
        throw new Error("Invalid phone number");
    }
    return phone;
}
