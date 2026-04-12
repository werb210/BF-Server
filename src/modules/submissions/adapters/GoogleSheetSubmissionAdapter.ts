import { config } from "../../../config/index.js";
import { logError, logInfo } from "../../../observability/logger.js";
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

// Lazy load to prevent hard crash if dependency is unavailable.
try {
  const mod = await import("googleapis");
  google = mod.google;
} catch (err) {
  logError("googleapis_not_installed", { error: err });
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

  constructor(params: { payload: SubmissionPayload; config: GoogleSheetSubmissionConfig }) {
    if (!google) {
      logError("google_sheets_adapter_disabled");
      return;
    }

    this.spreadsheetId = params.config.spreadsheetId;

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: config.google.serviceAccountEmail,
        private_key: config.google.serviceAccountPrivateKey?.replace(/\\n/g, "\n"),
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    this.sheets = google.sheets({ version: "v4", auth });
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
