import { config } from "@/config";
import { google } from "googleapis";
import {
  type GoogleSheetsPayload,
  type GoogleSheetsSheetMap,
} from "../config/merchantGrowth.sheetMap";
import { logError, logInfo } from "../../observability/logger";

export type GoogleSheetsSubmissionResult = {
  success: boolean;
  response: {
    status: string;
    detail?: string;
    receivedAt: string;
  };
  failureReason: string | null;
  retryable: boolean;
};

export type GoogleSheetsSubmissionParams = {
  payload: GoogleSheetsPayload;
  sheetId: string;
  sheetTab?: string | null;
  sheetMap: GoogleSheetsSheetMap;
};

function assertGoogleEnv(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
} {
  const clientId = config.google.clientId?.trim();
  const clientSecret = config.google.clientSecret?.trim();
  const redirectUri = config.google.redirectUri?.trim();
  const refreshToken = config.google.refreshToken?.trim();
  if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
    throw new Error("Missing Google Sheets OAuth environment configuration.");
  }
  return { clientId, clientSecret, redirectUri, refreshToken };
}

function columnIndexToLetter(index: number): string {
  let result = "";
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function resolveSheetTitle(response: {
  data?: { sheets?: Array<{ properties?: { title?: string | null } | null } | null> };
}): string {
  const title = response.data?.sheets?.[0]?.properties?.title ?? null;
  if (!title) {
    throw new Error("Unable to resolve Google Sheet tab name.");
  }
  return title;
}

function normalizeCellValue(value: string | number | null): string | number {
  if (value === null || value === undefined) {
    return "";
  }
  return value;
}

function resolveRetryableError(error: unknown): boolean {
  const status =
    (error as { response?: { status?: number } })?.response?.status ??
    (error as { code?: number })?.code;
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }
  return false;
}

export async function submitGoogleSheetsApplication(
  params: GoogleSheetsSubmissionParams
): Promise<GoogleSheetsSubmissionResult> {
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
    const sheetTitle =
      params.sheetTab && params.sheetTab.trim().length > 0
        ? params.sheetTab.trim()
        : resolveSheetTitle(
            await sheets.spreadsheets.get({
              spreadsheetId: params.sheetId,
            })
          );

    const applicationIdIndex = params.sheetMap.columns.findIndex(
      (column: any) => column.header === params.sheetMap.applicationIdHeader
    );
    if (applicationIdIndex === -1) {
      throw new Error("Application ID column is missing from sheet map.");
    }

    const idColumnLetter = columnIndexToLetter(applicationIdIndex);
    const idRange = `${sheetTitle}!${idColumnLetter}:${idColumnLetter}`;
    const idValuesResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: params.sheetId,
      range: idRange,
    });

    const sheetRows = (idValuesResponse.data.values ?? []) as Array<
      Record<string, string | number | null>
    >;
    const existingIds = new Set(
      sheetRows
        .map((row: Record<string, string | number | null>) => row?.[0] ?? null)
        .filter(
          (value: string | number | null): value is string =>
            typeof value === "string" && value.trim().length > 0
        )
        .filter((value: string) => value !== params.sheetMap.applicationIdHeader)
    );

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

    const row = params.sheetMap.columns.map((column: any) =>
      normalizeCellValue(column.value(params.payload))
    );
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
  } catch (error) {
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
