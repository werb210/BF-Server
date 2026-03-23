import { config } from "@/config";
import { type SubmissionAdapter, type SubmissionResult } from "./SubmissionAdapter";
import {
  GoogleSheetsAdapter,
  type GoogleSheetsPayload,
  type GoogleSheetsSubmissionConfig,
} from "./googleSheets.adapter";
import { EmailAdapter } from "./adapters/EmailAdapter";
import { ApiAdapter } from "./adapters/ApiAdapter";

export type SubmissionMethod = "google_sheet" | "email" | "api" | "manual";

type SubmissionRouterParams = {
  method: SubmissionMethod;
  payload: Record<string, unknown>;
  attempt: number;
  lenderId: string;
  submissionEmail?: string | null;
  submissionConfig?: Record<string, unknown> | null;
};

function asGoogleSheetsConfig(
  config: Record<string, unknown> | null | undefined
): GoogleSheetsSubmissionConfig | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  const sheetId = typeof config.sheetId === "string" ? config.sheetId.trim() : "";
  const sheetTab = typeof config.sheetTab === "string" ? config.sheetTab.trim() : null;
  const mapping =
    config.mapping && typeof config.mapping === "object"
      ? (config.mapping as GoogleSheetsSubmissionConfig["mapping"])
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
  private adapter: SubmissionAdapter;

  constructor(params: SubmissionRouterParams) {
    if (params.method === "google_sheet") {
      const sheetConfig = asGoogleSheetsConfig(params.submissionConfig);
      if (!sheetConfig) {
        throw new Error("Google Sheets submission config is required.");
      }
      this.adapter = new GoogleSheetsAdapter({
        payload: params.payload as GoogleSheetsPayload,
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

  async submit(applicationId: string): Promise<SubmissionResult> {
    return this.adapter.submit(applicationId);
  }
}
