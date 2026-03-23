import { config } from "@/config";
import { google } from "googleapis";
import { logError, logInfo } from "../../../observability/logger";
import {
  type SubmissionAdapter,
  type SubmissionPayload,
  type SubmissionResult,
} from "./SubmissionAdapter";

export type GoogleSheetSubmissionConfig = {
  spreadsheetId: string;
  sheetName?: string | null;
  columnMapVersion: string;
};

export type GoogleSheetColumnMap = Record<string, string>;

const COLUMN_MAPS: Record<string, GoogleSheetColumnMap> = {
  v1: {
    "Application ID": "application.id",
    "Submitted At": "submittedAt",
    "Applicant First Name": "application.metadata.applicant.firstName",
    "Applicant Last Name": "application.metadata.applicant.lastName",
    "Requested Amount": "application.requestedAmount",
    "Product Type": "application.productType",
  },
};

const APPLICATION_ID_PATH = "application.id";

function assertServiceAccountEnv(): { client_email: string; private_key: string } {
  const clientEmail = config.google.serviceAccountEmail?.trim();
  const privateKey = config.google.serviceAccountPrivateKey?.trim();
  if (!clientEmail || !privateKey) {
    throw new Error("Missing Google service account credentials.");
  }
  return {
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, "\n"),
  };
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
},
requestedTab?: string | null): string {
  const sheets = response.data?.sheets ?? [];
  if (requestedTab) {
    const match = sheets.find(
      (sheet) => sheet?.properties?.title?.trim() === requestedTab.trim()
    );
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

function resolveRetryableError(error: unknown): boolean {
  const status =
    (error as { response?: { status?: number } })?.response?.status ??
    (error as { code?: number })?.code;
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }
  return false;
}

function fetchPathValue(source: unknown, path: string): unknown {
  if (!path) {
    return undefined;
  }
  return path.split(".").reduce<unknown>((acc, segment) => {
    if (acc === null || acc === undefined) {
      return undefined;
    }
    const current = acc as Record<string, unknown>;
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

function resolveMappedValue(payload: SubmissionPayload, path: string): string | number | null {
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

function normalizeCellValue(value: string | number | null): string | number {
  if (value === null || value === undefined) {
    return "";
  }
  return value;
}

function resolveColumnMap(version: string): GoogleSheetColumnMap {
  const normalized = version.trim();
  return COLUMN_MAPS[normalized] ?? {};
}

function parseUpdatedRowIndex(range: string | null | undefined): number | null {
  if (!range) {
    return null;
  }
  const match = range.match(/!\D*(\d+):/);
  if (!match) {
    return null;
  }
  const row = Number(match[1]);
  return Number.isFinite(row) ? row : null;
}

export class GoogleSheetSubmissionAdapter implements SubmissionAdapter {
  private payload: SubmissionPayload;
  private config: GoogleSheetSubmissionConfig;

  constructor(params: { payload: SubmissionPayload; config: GoogleSheetSubmissionConfig }) {
    this.payload = params.payload;
    this.config = params.config;
  }

  async submit(_input: SubmissionPayload): Promise<SubmissionResult> {
    const now = new Date().toISOString();
    const credentials = assertServiceAccountEnv();
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    logInfo("google_sheet_submission_attempt", {
      applicationId: this.payload.application.id,
      sheetId: this.config.spreadsheetId,
    });

    try {
      if (!this.config.spreadsheetId || !this.config.spreadsheetId.trim()) {
        throw new Error("Google Sheet spreadsheetId is required.");
      }

      const mapping = resolveColumnMap(this.config.columnMapVersion);
      const mappingHeaders = Object.keys(mapping);
      if (mappingHeaders.length === 0) {
        throw new Error("Google Sheet columnMapVersion is invalid.");
      }

      const sheetMeta = await sheets.spreadsheets.get({
        spreadsheetId: this.config.spreadsheetId,
      });
      const sheetTitle = resolveSheetTitle(sheetMeta, this.config.sheetName ?? null);

      const headerResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range: `${sheetTitle}!1:1`,
      });
      const headerRow = (headerResponse.data.values?.[0] ?? []) as string[];
      if (headerRow.length === 0) {
        throw new Error("Google Sheet header row is missing.");
      }

      const missingHeaders = mappingHeaders.filter((header) => !headerRow.includes(header));
      if (missingHeaders.length > 0) {
        throw new Error("Google Sheet mapping does not match sheet headers.");
      }

      const applicationIdHeader = mappingHeaders.find(
        (header) => mapping[header] === APPLICATION_ID_PATH
      );
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
        spreadsheetId: this.config.spreadsheetId,
        range: idRange,
      });

      const idRows: Array<unknown[]> = (idValuesResponse.data.values ?? []) as Array<
        unknown[]
      >;
      let existingRowIndex: number | null = null;
      idRows.forEach((row, index) => {
        const value = Array.isArray(row) ? row[0] : null;
        const rowIndex = index + 1;
        if (
          typeof value === "string" &&
          value.trim().length > 0 &&
          value !== applicationIdHeader &&
          value === this.payload.application.id
        ) {
          existingRowIndex = rowIndex;
        }
      });

      if (existingRowIndex) {
        logInfo("google_sheet_submission_idempotent", {
          applicationId: this.payload.application.id,
          sheetId: this.config.spreadsheetId,
          rowIndex: existingRowIndex,
        });
        return {
          success: true,
          response: {
            status: "duplicate",
            detail: "Application already exists in sheet.",
            receivedAt: now,
            externalReference: String(existingRowIndex),
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
        spreadsheetId: this.config.spreadsheetId,
        range: appendRange,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [row],
        },
      });

      const updatedRange = appendResponse.data.updates?.updatedRange ?? null;
      const rowIndex = parseUpdatedRowIndex(updatedRange);

      return {
        success: true,
        response: {
          status: "appended",
          detail: "Application appended to Google Sheet.",
          receivedAt: now,
          externalReference: rowIndex ? String(rowIndex) : updatedRange,
        },
        failureReason: null,
        retryable: false,
      };
    } catch (error) {
      logError("google_sheet_submission_failed", {
        error,
        applicationId: this.payload.application.id,
        sheetId: this.config.spreadsheetId,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        success: false,
        response: {
          status: "error",
          detail: error instanceof Error ? error.message : "Unknown Google Sheets error.",
          receivedAt: now,
        },
        failureReason: "google_sheet_error",
        retryable: resolveRetryableError(error),
      };
    }
  }
}
