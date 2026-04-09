import { config } from "../../config/index.js";
import { google } from "googleapis";
import { logError, logInfo } from "../../observability/logger.js";
function assertGoogleEnv() {
    const clientId = config.google.clientId?.trim();
    const clientSecret = config.google.clientSecret?.trim();
    const redirectUri = config.google.redirectUri?.trim();
    const refreshToken = config.google.refreshToken?.trim();
    if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
        throw new Error("Missing Google Sheets OAuth environment configuration.");
    }
    return { clientId, clientSecret, redirectUri, refreshToken };
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
function resolveSheetTitle(response) {
    const title = response.data?.sheets?.[0]?.properties?.title ?? null;
    if (!title) {
        throw new Error("Unable to resolve Google Sheet tab name.");
    }
    return title;
}
function normalizeCellValue(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return value;
}
function resolveRetryableError(error) {
    const status = error?.response?.status ??
        error?.code;
    if (typeof status === "number") {
        return status === 429 || status >= 500;
    }
    return false;
}
export async function submitGoogleSheetsApplication(params) {
    const now = new Date().toISOString();
    const { clientId, clientSecret, redirectUri, refreshToken } = assertGoogleEnv();
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2Client });
    logInfo("google_sheets_submission_attempt", {
        applicationId: params.payload.application.id,
        sheetId: params.sheetId,
    });
    try {
        const sheetTitle = params.sheetTab && params.sheetTab.trim().length > 0
            ? params.sheetTab.trim()
            : resolveSheetTitle(await sheets.spreadsheets.get({
                spreadsheetId: params.sheetId,
            }));
        const applicationIdIndex = params.sheetMap.columns.findIndex((column) => column.header === params.sheetMap.applicationIdHeader);
        if (applicationIdIndex === -1) {
            throw new Error("Application ID column is missing from sheet map.");
        }
        const idColumnLetter = columnIndexToLetter(applicationIdIndex);
        const idRange = `${sheetTitle}!${idColumnLetter}:${idColumnLetter}`;
        const idValuesResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: params.sheetId,
            range: idRange,
        });
        const sheetRows = (idValuesResponse.data.values ?? []);
        const existingIds = new Set(sheetRows
            .map((row) => row?.[0] ?? null)
            .filter((value) => typeof value === "string" && value.trim().length > 0)
            .filter((value) => value !== params.sheetMap.applicationIdHeader));
        if (existingIds.has(params.payload.application.id)) {
            logInfo("google_sheets_submission_idempotent", {
                applicationId: params.payload.application.id,
                sheetId: params.sheetId,
            });
            return {
                success: true,
                response: {
                    status: "duplicate",
                    detail: "Application already exists in sheet.",
                    receivedAt: now,
                },
                failureReason: null,
                retryable: false,
            };
        }
        const row = params.sheetMap.columns.map((column) => normalizeCellValue(column.value(params.payload)));
        const endColumnLetter = columnIndexToLetter(params.sheetMap.columns.length - 1);
        const appendRange = `${sheetTitle}!A:${endColumnLetter}`;
        await sheets.spreadsheets.values.append({
            spreadsheetId: params.sheetId,
            range: appendRange,
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: {
                values: [row],
            },
        });
        return {
            success: true,
            response: {
                status: "appended",
                detail: "Application appended to Google Sheet.",
                receivedAt: now,
            },
            failureReason: null,
            retryable: false,
        };
    }
    catch (error) {
        logError("google_sheets_submission_failed", {
            error,
            applicationId: params.payload.application.id,
            sheetId: params.sheetId,
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
