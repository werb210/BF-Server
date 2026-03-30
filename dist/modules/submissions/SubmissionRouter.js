"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubmissionRouter = void 0;
exports.normalizeSubmissionMethod = normalizeSubmissionMethod;
exports.resolveSubmissionProfile = resolveSubmissionProfile;
const db_1 = require("../../db");
const EmailSubmissionAdapter_1 = require("./adapters/EmailSubmissionAdapter");
const ApiSubmissionAdapter_1 = require("./adapters/ApiSubmissionAdapter");
const GoogleSheetSubmissionAdapter_1 = require("./adapters/GoogleSheetSubmissionAdapter");
function normalizeSubmissionMethod(value) {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    const mapped = normalized === "google_sheets" ? "google_sheet" : normalized;
    return mapped === "api" || mapped === "email" || mapped === "google_sheet"
        ? mapped
        : null;
}
function parseGoogleSheetConfig(config) {
    if (!config || typeof config !== "object") {
        throw new Error("Google Sheet submission config is required.");
    }
    const spreadsheetId = typeof config.spreadsheetId === "string"
        ? config.spreadsheetId.trim()
        : "";
    const sheetName = typeof config.sheetName === "string"
        ? config.sheetName.trim()
        : null;
    const columnMapVersion = typeof config.columnMapVersion === "string"
        ? config.columnMapVersion.trim()
        : "";
    if (!spreadsheetId) {
        throw new Error("submission_config.spreadsheetId is required.");
    }
    if (!columnMapVersion) {
        throw new Error("submission_config.columnMapVersion is required.");
    }
    return { spreadsheetId, sheetName, columnMapVersion };
}
async function resolveSubmissionProfile(lenderId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select submission_method, submission_email, name, submission_config
     from lenders
     where id = $1
     limit 1`, [lenderId]);
    if (res.rows.length === 0) {
        throw new Error("Lender not found.");
    }
    const row = res.rows[0];
    if (!row) {
        throw new Error("Lender not found.");
    }
    const method = normalizeSubmissionMethod(row.submission_method) ?? "email";
    const submissionEmail = row.submission_email ?? null;
    if (method === "email" && (!submissionEmail || !submissionEmail.trim())) {
        throw new Error("Submission email is required.");
    }
    const submissionConfig = row.submission_config ?? null;
    if (method === "api" && !submissionConfig) {
        throw new Error("Submission config is required for API submissions.");
    }
    if (method === "google_sheet") {
        parseGoogleSheetConfig(submissionConfig);
    }
    return {
        lenderId,
        lenderName: row.name ?? "",
        submissionMethod: method,
        submissionEmail,
        submissionConfig,
    };
}
class SubmissionRouter {
    adapter;
    payload;
    constructor(params) {
        this.payload = params.payload;
        const { profile } = params;
        if (profile.submissionMethod === "google_sheet") {
            const sheetConfig = parseGoogleSheetConfig(profile.submissionConfig);
            this.adapter = new GoogleSheetSubmissionAdapter_1.GoogleSheetSubmissionAdapter({
                payload: params.payload,
                config: sheetConfig,
            });
            return;
        }
        if (profile.submissionMethod === "email") {
            const target = profile.submissionEmail ?? "";
            if (!target) {
                throw new Error("Submission email is required.");
            }
            this.adapter = new EmailSubmissionAdapter_1.EmailSubmissionAdapter({ to: target, payload: params.payload });
            return;
        }
        if (profile.submissionMethod === "api") {
            this.adapter = new ApiSubmissionAdapter_1.ApiSubmissionAdapter({
                lenderId: profile.lenderId,
                payload: params.payload,
                attempt: params.attempt,
            });
            return;
        }
        throw new Error("Unsupported submission method.");
    }
    async submit() {
        return this.adapter.submit(this.payload);
    }
}
exports.SubmissionRouter = SubmissionRouter;
