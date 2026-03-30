"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleSheetsAdapter = void 0;
const config_1 = require("../../config");
const googleapis_1 = require("googleapis");
const logger_1 = require("../../observability/logger");
const APPLICATION_ID_PATH = "application.id";
function assertServiceAccountEnv() {
    const clientEmail = config_1.config.google.serviceAccountEmail?.trim();
    const privateKey = config_1.config.google.serviceAccountPrivateKey?.trim();
    if (!clientEmail || !privateKey) {
        throw new Error("Missing Google service account credentials.");
    }
    return {
        client_email: clientEmail,
        private_key: privateKey.replace(/\\n/g, "\n"),
    };
}
function columnIndexToLetter(index) {
    let result = "";
    let current = index + 1;
    while (current > 0) {
        const remainder = (current - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        current = Math.floor((current - 1) / 26);
    }
    return result;
}
function resolveSheetTitle(response, requestedTab) {
    const sheets = response.data?.sheets ?? [];
    if (requestedTab) {
        const match = sheets.find((sheet) => sheet?.properties?.title?.trim() === requestedTab.trim());
        if (!match?.properties?.title) {
            throw new Error("Unable to access requested Google Sheet tab.");
        }
        return match.properties.title;
    }
    const title = sheets[0]?.properties?.title ?? null;
    if (!title) {
        throw new Error("Unable to resolve Google Sheet tab name.");
    }
    return title;
}
function resolveRetryableError(error) {
    const status = error?.response?.status ??
        error?.code;
    if (typeof status === "number") {
        return status === 429 || status >= 500;
    }
    return false;
}
function fetchPathValue(source, path) {
    if (!path) {
        return undefined;
    }
    return path.split(".").reduce((acc, segment) => {
        if (acc === null || acc === undefined) {
            return undefined;
        }
        const current = acc;
        if (segment === "") {
            return acc;
        }
        if (Array.isArray(current) && /^\d+$/.test(segment)) {
            const index = Number(segment);
            return current[index];
        }
        if (typeof current !== "object") {
            return undefined;
        }
        return current[segment];
    }, source);
}
function resolveMappedValue(payload, path) {
    const resolved = fetchPathValue(payload, path);
    if (resolved === null || resolved === undefined) {
        return null;
    }
    if (typeof resolved === "number" && Number.isFinite(resolved)) {
        return resolved;
    }
    if (typeof resolved === "string") {
        return resolved;
    }
    return String(resolved);
}
function normalizeCellValue(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return value;
}
function normalizeMapping(mapping) {
    if (!mapping || typeof mapping !== "object") {
        return {};
    }
    return Object.entries(mapping).reduce((acc, [header, path]) => {
        if (typeof header === "string" && typeof path === "string" && header.trim()) {
            acc[header.trim()] = path.trim();
        }
        return acc;
    }, {});
}
class GoogleSheetsAdapter {
    constructor(params) {
        this.payload = params.payload;
        this.config = params.config;
    }
    async submit(applicationId) {
        const now = new Date().toISOString();
        const credentials = assertServiceAccountEnv();
        const auth = new googleapis_1.google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        const sheets = googleapis_1.google.sheets({ version: "v4", auth });
        (0, logger_1.logInfo)("google_sheets_submission_attempt", {
            applicationId,
            sheetId: this.config.sheetId,
        });
        try {
            if (!this.config.sheetId || !this.config.sheetId.trim()) {
                throw new Error("Google Sheet ID is required.");
            }
            const mapping = normalizeMapping(this.config.mapping);
            const mappingHeaders = Object.keys(mapping);
            if (mappingHeaders.length === 0) {
                throw new Error("Google Sheet mapping is required.");
            }
            const sheetMeta = await sheets.spreadsheets.get({
                spreadsheetId: this.config.sheetId,
            });
            const sheetTitle = resolveSheetTitle(sheetMeta, this.config.sheetTab ?? null);
            const headerResponse = await sheets.spreadsheets.values.get({
                spreadsheetId: this.config.sheetId,
                range: `${sheetTitle}!1:1`,
            });
            const headerRow = (headerResponse.data.values?.[0] ?? []);
            if (headerRow.length === 0) {
                throw new Error("Google Sheet header row is missing.");
            }
            const missingHeaders = mappingHeaders.filter((header) => !headerRow.includes(header));
            if (missingHeaders.length > 0) {
                throw new Error("Google Sheet mapping does not match sheet headers.");
            }
            const applicationIdHeader = mappingHeaders.find((header) => mapping[header] === APPLICATION_ID_PATH);
            if (!applicationIdHeader) {
                throw new Error("Application ID mapping is required.");
            }
            const applicationIdIndex = headerRow.indexOf(applicationIdHeader);
            if (applicationIdIndex === -1) {
                throw new Error("Application ID column is missing from sheet.");
            }
            const idColumnLetter = columnIndexToLetter(applicationIdIndex);
            const idRange = `${sheetTitle}!${idColumnLetter}:${idColumnLetter}`;
            const idValuesResponse = await sheets.spreadsheets.values.get({
                spreadsheetId: this.config.sheetId,
                range: idRange,
            });
            const idRows = (idValuesResponse.data.values ?? []);
            const existingIds = new Set(idRows
                .map((row) => (Array.isArray(row) ? row[0] : null))
                .filter((value) => typeof value === "string" && value.trim().length > 0)
                .filter((value) => value !== applicationIdHeader));
            if (existingIds.has(this.payload.application.id)) {
                (0, logger_1.logInfo)("google_sheets_submission_idempotent", {
                    applicationId: this.payload.application.id,
                    sheetId: this.config.sheetId,
                });
                return {
                    success: true,
                    response: {
                        status: "duplicate",
                        detail: "Application already exists in sheet.",
                        receivedAt: now,
                        externalReference: "duplicate",
                    },
                    failureReason: null,
                    retryable: false,
                };
            }
            const row = headerRow.map((header) => {
                const path = mapping[header];
                if (!path) {
                    return "";
                }
                return normalizeCellValue(resolveMappedValue(this.payload, path));
            });
            const endColumnLetter = columnIndexToLetter(headerRow.length - 1);
            const appendRange = `${sheetTitle}!A:${endColumnLetter}`;
            const appendResponse = await sheets.spreadsheets.values.append({
                spreadsheetId: this.config.sheetId,
                range: appendRange,
                valueInputOption: "USER_ENTERED",
                insertDataOption: "INSERT_ROWS",
                requestBody: {
                    values: [row],
                },
            });
            const externalReference = appendResponse.data.updates?.updatedRange ?? null;
            return {
                success: true,
                response: {
                    status: "appended",
                    detail: "Application appended to Google Sheet.",
                    receivedAt: now,
                    externalReference,
                },
                failureReason: null,
                retryable: false,
            };
        }
        catch (error) {
            (0, logger_1.logError)("google_sheets_submission_failed", {
                error,
                applicationId: this.payload.application.id,
                sheetId: this.config.sheetId,
                stack: error instanceof Error ? error.stack : undefined,
            });
            return {
                success: false,
                response: {
                    status: "error",
                    detail: error instanceof Error ? error.message : "Unknown Google Sheets error.",
                    receivedAt: now,
                },
                failureReason: "google_sheets_error",
                retryable: resolveRetryableError(error),
            };
        }
    }
}
exports.GoogleSheetsAdapter = GoogleSheetsAdapter;
