"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTelephonyStatus = getTelephonyStatus;
function getTelephonyStatus() {
    return {
        enabled: !!process.env.TWILIO_ACCOUNT_SID,
    };
}
