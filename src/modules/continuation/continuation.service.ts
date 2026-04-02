import { randomBytes } from "node:crypto";
import { pool, runQuery } from "../../db";

export type ContinuationPayload = {
  companyName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  industry?: string;
  yearsInBusiness?: number | string;
  monthlyRevenue?: number | string;
  annualRevenue?: number | string;
  arOutstanding?: number | string;
  existingDebt?: boolean | string;
};

function toNullableNumber(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableInteger(value: number | string | undefined): number | null {
  const parsed = toNullableNumber(value);
  if (parsed === null) {
    return null;
  }
  return Math.trunc(parsed);
}

function toNullableBoolean(value: boolean | string | undefined): boolean | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  return null;
}

export async function createContinuation(
  payload: ContinuationPayload,
  crmLeadId: string
): Promise<string> {
  const token = randomBytes(24).toString("hex");

  await runQuery(
    `
    INSERT INTO application_continuations (
      token,
      company_name,
      full_name,
      email,
      phone,
      industry,
      years_in_business,
      monthly_revenue,
      annual_revenue,
      ar_outstanding,
      existing_debt,
      crm_lead_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `,
    [
      token,
      payload.companyName ?? null,
      payload.fullName ?? null,
      payload.email ?? null,
      payload.phone ?? null,
      payload.industry ?? null,
      toNullableInteger(payload.yearsInBusiness),
      toNullableNumber(payload.monthlyRevenue),
      toNullableNumber(payload.annualRevenue),
      toNullableNumber(payload.arOutstanding),
      toNullableBoolean(payload.existingDebt),
      crmLeadId,
    ]
  );

  return token;
}

export async function fetchContinuation(token: string): Promise<Record<string, unknown> | null> {
  const { rows } = await runQuery(
    "SELECT * FROM application_continuations WHERE token = $1",
    [token]
  );

  return rows[0] ?? null;
}

export async function convertContinuation(
  token: string,
  applicationId: string
): Promise<void> {
  await runQuery(
    `
    UPDATE application_continuations
    SET converted_application_id = $1,
        converted_at = NOW()
    WHERE token = $2
    `,
    [applicationId, token]
  );
}
