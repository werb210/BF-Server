"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiAdapter = void 0;
class ApiAdapter {
    lenderId;
    payload;
    attempt;
    constructor(params) {
        this.lenderId = params.lenderId;
        this.payload = params.payload;
        this.attempt = params.attempt;
    }
    async submit(_applicationId) {
        const now = new Date().toISOString();
        if (this.lenderId === "timeout" && this.attempt === 0) {
            return {
                success: false,
                response: {
                    status: "timeout",
                    detail: "Lender did not respond.",
                    receivedAt: now,
                },
                failureReason: "lender_timeout",
                retryable: true,
            };
        }
        const forceFailure = typeof this.payload === "object" &&
            this.payload !== null &&
            typeof this.payload
                .application?.metadata === "object" &&
            this.payload.application
                ?.metadata?.forceFailure;
        if (this.attempt === 0 && forceFailure) {
            return {
                success: false,
                response: {
                    status: "error",
                    detail: "Forced lender error.",
                    receivedAt: now,
                },
                failureReason: "lender_error",
                retryable: true,
            };
        }
        return {
            success: true,
            response: {
                status: "accepted",
                receivedAt: now,
            },
            failureReason: null,
            retryable: false,
        };
    }
}
exports.ApiAdapter = ApiAdapter;
