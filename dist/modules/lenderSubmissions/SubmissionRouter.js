"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubmissionRouter = void 0;
const googleSheets_adapter_1 = require("./googleSheets.adapter");
const EmailAdapter_1 = require("./adapters/EmailAdapter");
const ApiAdapter_1 = require("./adapters/ApiAdapter");
function asGoogleSheetsConfig(config) {
    if (!config || typeof config !== "object") {
        return null;
    }
    const sheetId = typeof config.sheetId === "string" ? config.sheetId.trim() : "";
    const sheetTab = typeof config.sheetTab === "string" ? config.sheetTab.trim() : null;
    const mapping = config.mapping && typeof config.mapping === "object"
        ? config.mapping
        : null;
    if (!sheetId || !mapping || Object.keys(mapping).length === 0) {
        return null;
    }
    return {
        sheetId,
        sheetTab,
        mapping,
    };
}
class SubmissionRouter {
    constructor(params) {
        if (params.method === "google_sheet") {
            const sheetConfig = asGoogleSheetsConfig(params.submissionConfig);
            if (!sheetConfig) {
                throw new Error("Google Sheets submission config is required.");
            }
            this.adapter = new googleSheets_adapter_1.GoogleSheetsAdapter({
                payload: params.payload,
                config: sheetConfig,
            });
            return;
        }
        if (params.method === "email") {
            const target = params.submissionEmail ?? "";
            if (!target) {
                throw new Error("Submission email is required.");
            }
            this.adapter = new EmailAdapter_1.EmailAdapter({ to: target, payload: params.payload });
            return;
        }
        if (params.method === "api") {
            this.adapter = new ApiAdapter_1.ApiAdapter({
                lenderId: params.lenderId,
                payload: params.payload,
                attempt: params.attempt,
            });
            return;
        }
        this.adapter = {
            submit: async () => ({
                success: false,
                response: {
                    status: "manual",
                    detail: "Manual submission required.",
                    receivedAt: new Date().toISOString(),
                    externalReference: null,
                },
                failureReason: "manual_required",
                retryable: false,
            }),
        };
    }
    async submit(applicationId) {
        return this.adapter.submit(applicationId);
    }
}
exports.SubmissionRouter = SubmissionRouter;
