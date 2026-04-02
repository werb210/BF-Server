import { pool, runQuery } from "../../db";
import { type PoolClient } from "pg";
import {
  type SubmissionAdapter,
  type SubmissionPayload,
  type SubmissionResult,
} from "./adapters/SubmissionAdapter";
import { EmailSubmissionAdapter } from "./adapters/EmailSubmissionAdapter";
import { ApiSubmissionAdapter } from "./adapters/ApiSubmissionAdapter";
import {
  GoogleSheetSubmissionAdapter,
  type GoogleSheetSubmissionConfig,
} from "./adapters/GoogleSheetSubmissionAdapter";

export type SubmissionMethod = "google_sheet" | "email" | "api";

export type SubmissionProfile = {
  lenderId: string;
  lenderName: string;
  submissionMethod: SubmissionMethod;
  submissionEmail: string | null;
  submissionConfig: Record<string, unknown> | null;
};

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export function normalizeSubmissionMethod(value: unknown): SubmissionMethod | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  const mapped = normalized === "google_sheets" ? "google_sheet" : normalized;
  return mapped === "api" || mapped === "email" || mapped === "google_sheet"
    ? mapped
    : null;
}

function parseGoogleSheetConfig(config: Record<string, unknown> | null): GoogleSheetSubmissionConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Google Sheet submission config is required.");
  }
  const spreadsheetId =
    typeof (config as { spreadsheetId?: unknown }).spreadsheetId === "string"
      ? (config as { spreadsheetId: string }).spreadsheetId.trim()
      : "";
  const sheetName =
    typeof (config as { sheetName?: unknown }).sheetName === "string"
      ? (config as { sheetName: string }).sheetName.trim()
      : null;
  const columnMapVersion =
    typeof (config as { columnMapVersion?: unknown }).columnMapVersion === "string"
      ? (config as { columnMapVersion: string }).columnMapVersion.trim()
      : "";
  if (!spreadsheetId) {
    throw new Error("submission_config.spreadsheetId is required.");
  }
  if (!columnMapVersion) {
    throw new Error("submission_config.columnMapVersion is required.");
  }
  return { spreadsheetId, sheetName, columnMapVersion };
}

export async function resolveSubmissionProfile(
  lenderId: string,
  client?: Queryable
): Promise<SubmissionProfile> {
  const runner = client ?? pool;
  const res = await runner.query<{
    submission_method: string | null;
    submission_email: string | null;
    name: string | null;
    submission_config: Record<string, unknown> | null;
  }>(
    `select submission_method, submission_email, name, submission_config
     from lenders
     where id = $1
     limit 1`,
    [lenderId]
  );
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

type SubmissionRouterParams = {
  profile: SubmissionProfile;
  payload: SubmissionPayload;
  attempt: number;
};

export class SubmissionRouter {
  private adapter: SubmissionAdapter;
  private payload: SubmissionPayload;

  constructor(params: SubmissionRouterParams) {
    this.payload = params.payload;
    const { profile } = params;
    if (profile.submissionMethod === "google_sheet") {
      const sheetConfig = parseGoogleSheetConfig(profile.submissionConfig);
      this.adapter = new GoogleSheetSubmissionAdapter({
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
      this.adapter = new EmailSubmissionAdapter({ to: target, payload: params.payload });
      return;
    }

    if (profile.submissionMethod === "api") {
      this.adapter = new ApiSubmissionAdapter({
        lenderId: profile.lenderId,
        payload: params.payload,
        attempt: params.attempt,
      });
      return;
    }

    throw new Error("Unsupported submission method.");
  }

  async submit(): Promise<SubmissionResult> {
    return this.adapter.submit(this.payload);
  }
}
