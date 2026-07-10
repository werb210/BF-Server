import { config } from "../../../config/index.js";
import { logError, logInfo } from "../../../observability/logger.js";
import { safeImport } from "../../../utils/safeImport.js";
import {
  type SubmissionAdapter,
  type SubmissionPayload,
  type SubmissionResult,
} from "./SubmissionAdapter.js";

export type GoogleSheetSubmissionConfig = {
  spreadsheetId: string;
  sheetName?: string | null;
  columnMapVersion: string;
};

let google: any = null;

const googleMod: any = await safeImport("googleapis");
google = googleMod?.google ?? null;
if (!google) {
  logError("googleapis_not_installed");
}

function unavailableResult(reason: string): SubmissionResult {
  return {
    success: false,
    response: {
      status: "failed",
      detail: reason,
      receivedAt: new Date().toISOString(),
      externalReference: null,
    },
    failureReason: reason,
    retryable: false,
  };
}

export class GoogleSheetSubmissionAdapter implements SubmissionAdapter {
  private sheets: any = null;
  private spreadsheetId: string | null = null;
  // BF_SERVER_GSHEET_ROW_v1 - honor the configured tab instead of hardcoding "Sheet1".
  private sheetName: string = "Sheet1";

  constructor(params: { payload: SubmissionPayload; config: GoogleSheetSubmissionConfig }) {
    if (!google) {
      logError("google_sheets_adapter_disabled");
      return;
    }

    this.spreadsheetId = params.config.spreadsheetId;
    if (params.config.sheetName && String(params.config.sheetName).trim()) {
      this.sheetName = String(params.config.sheetName).trim();
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: config.google.serviceAccountEmail,
        private_key: config.google.serviceAccountPrivateKey?.replace(/\\n/g, "\n"),
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    this.sheets = google.sheets({ version: "v4", auth });
  }

  // BF_SERVER_GSHEET_ROW_v1 - append a pre-built, column-ordered row. This is the
  // real submission path (the generic submit() dumped Object.values, which is not
  // column-mapped). Values must already be in the sheet's column order.
  async appendRow(values: (string | number | null)[]): Promise<SubmissionResult> {
    if (!this.sheets) {
      logError("google_sheets_unavailable_skip");
      return unavailableResult("Google Sheets adapter unavailable.");
    }
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [values] },
      });
      logInfo("google_sheet_row_appended");
      return {
        success: true,
        response: {
          status: "accepted",
          detail: "Appended row to Google Sheets.",
          receivedAt: new Date().toISOString(),
          externalReference: null,
        },
        failureReason: null,
        retryable: false,
      };
    } catch (err) {
      logError("google_sheet_append_failed", { error: err });
      return unavailableResult(
        `Google Sheets append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async submit(data: SubmissionPayload): Promise<SubmissionResult> {
    if (!this.sheets) {
      logError("google_sheets_unavailable_skip");
      return unavailableResult("Google Sheets adapter unavailable.");
    }

    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: "Sheet1!A1",
        valueInputOption: "RAW",
        requestBody: {
          values: [Object.values(data)],
        },
      });

      logInfo("google_sheet_submission_success");
      return {
        success: true,
        response: {
          status: "accepted",
          detail: "Submitted to Google Sheets.",
          receivedAt: new Date().toISOString(),
          externalReference: null,
        },
        failureReason: null,
        retryable: false,
      };
    } catch (err) {
      logError("google_sheet_submission_failed", { error: err });
      return unavailableResult("Google Sheets submission failed.");
    }
  }
}
