import { GoogleSheetsAdapter, } from "./googleSheets.adapter.js";
import { EmailAdapter } from "./adapters/EmailAdapter.js";
import { ApiAdapter } from "./adapters/ApiAdapter.js";
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
export class SubmissionRouter {
    adapter;
    constructor(params) {
        if (params.method === "google_sheet") {
            const sheetConfig = asGoogleSheetsConfig(params.submissionConfig);
            if (!sheetConfig) {
                throw new Error("Google Sheets submission config is required.");
            }
            this.adapter = new GoogleSheetsAdapter({
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
            this.adapter = new EmailAdapter({ to: target, payload: params.payload });
            return;
        }
        if (params.method === "api") {
            this.adapter = new ApiAdapter({
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
