"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailAdapter = void 0;
const config_1 = require("../../../config");
class EmailAdapter {
    to;
    constructor(params) {
        this.to = params.to;
        void params.payload;
    }
    async submit(_applicationId) {
        if (config_1.config.app.testMode === "true") {
            console.log("[TEST_MODE] EMAIL skipped");
            return {
                success: true,
                response: {
                    status: "accepted",
                    detail: "TEST_MODE email skipped",
                    receivedAt: new Date().toISOString(),
                    externalReference: "email_test_mode_skip",
                },
                failureReason: null,
                retryable: false,
            };
        }
        const now = new Date().toISOString();
        return {
            success: true,
            response: {
                status: "accepted",
                detail: `Email accepted for delivery to ${this.to}.`,
                receivedAt: now,
                externalReference: "email_stub",
            },
            failureReason: null,
            retryable: false,
        };
    }
}
exports.EmailAdapter = EmailAdapter;
