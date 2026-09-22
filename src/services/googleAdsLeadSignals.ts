// BF_SERVER_ADS_LEAD_SIGNALS_v400
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";
import { accessToken, conversionsConfigured, submitConversionsConfigured } from "./googleAdsConversions.js";

const API_VERSION = "v24";
export const QUALIFIED_STATES = ["off to lender", "offer", "accepted", "funded"];
export const CLOSED_STATES = ["rejected", "declined", "withdrawn", "closed"];

const digits = (value: unknown) => String(value ?? "").replace(/[^0-9]/g, "");
const customerId = () => digits(process.env.GOOGLE_ADS_CUSTOMER_ID);

function baseConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET && process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID,
  );
}

export function qualifiedConfigured(): boolean {
  return baseConfigured() && Boolean(digits(process.env.GOOGLE_ADS_QUALIFIED_CONVERSION_ACTION_ID));
}

export function fmtDateTime(value: string | Date): string {
  const parsed = new Date(value);
  return (Number.isNaN(parsed.getTime()) ? new Date() : parsed).toISOString().slice(0, 19).replace("T", " ") + "+00:00";
}

const CLICK_ID_SQL = `COALESCE(NULLIF(metadata->'attribution'->>'gclid',''), NULLIF(metadata->'attribution'->>'gbraid',''), NULLIF(metadata->'attribution'->>'wbraid',''))`;
const CLICK_FIELD_SQL = `CASE WHEN COALESCE(metadata->'attribution'->>'gclid','') <> '' THEN 'gclid'
                              WHEN COALESCE(metadata->'attribution'->>'gbraid','') <> '' THEN 'gbraid' ELSE 'wbraid' END`;

export type ClickField = "gclid" | "gbraid" | "wbraid";
export type QualifiedLead = { applicationId: string; clickId: string; clickField: ClickField; value: number; at: string };

export function qualifiedPayload(lead: QualifiedLead, cid: string, actionId: string, currency: string) {
  return {
    conversions: [{
      [lead.clickField]: lead.clickId,
      conversionAction: `customers/${cid}/conversionActions/${actionId}`,
      conversionDateTime: fmtDateTime(lead.at),
      ...(lead.value > 0 ? { conversionValue: lead.value, currencyCode: currency } : {}),
      orderId: `${lead.applicationId}-qualified`,
      consent: { adUserData: "GRANTED", adPersonalization: "GRANTED" },
    }],
    partialFailure: true,
  };
}

export function retractionPayload(applicationIds: string[], cid: string, submitActionId: string, when: Date = new Date()) {
  return {
    conversionAdjustments: applicationIds.map((id) => ({
      conversionAction: `customers/${cid}/conversionActions/${submitActionId}`,
      adjustmentType: "RETRACTION",
      orderId: `${id}-submit`,
      adjustmentDateTime: fmtDateTime(when),
    })),
    partialFailure: true,
  };
}

async function headers(): Promise<Record<string, string>> {
  const result: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
    "Content-Type": "application/json",
  };
  const loginCustomerId = digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  if (loginCustomerId) result["login-customer-id"] = loginCustomerId;
  return result;
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; detail: string }> {
  const response = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${customerId()}:${path}`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) return { ok: false, detail: `http ${response.status} ${text.slice(0, 300)}` };
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { /* An empty response body is valid. */ }
  if (parsed?.partialFailureError) return { ok: false, detail: JSON.stringify(parsed.partialFailureError).slice(0, 300) };
  return { ok: true, detail: "" };
}

export async function findPendingQualified(limit = 200): Promise<QualifiedLead[]> {
  const { rows } = await pool.query<{ id: string; click_id: string; click_field: ClickField; value: string | null; at: string }>(
    `SELECT id::text AS id, ${CLICK_ID_SQL} AS click_id, ${CLICK_FIELD_SQL} AS click_field,
            requested_amount AS value, COALESCE(updated_at, now())::text AS at
       FROM applications
      WHERE silo = 'BF'
        AND lower(COALESCE(pipeline_state, '')) = ANY($1)
        AND ${CLICK_ID_SQL} IS NOT NULL
        AND (metadata->'ad_qualified_conversion_uploaded_at') IS NULL
      ORDER BY updated_at DESC
      LIMIT $2`,
    [QUALIFIED_STATES, limit],
  );
  return rows.map((row) => ({
    applicationId: row.id,
    clickId: row.click_id,
    clickField: row.click_field,
    value: Number(row.value ?? 0),
    at: row.at,
  }));
}

export async function uploadQualifiedConversions(): Promise<{ configured: boolean; uploaded: number; failed: number }> {
  if (!qualifiedConfigured()) return { configured: false, uploaded: 0, failed: 0 };
  const actionId = digits(process.env.GOOGLE_ADS_QUALIFIED_CONVERSION_ACTION_ID);
  let uploaded = 0;
  let failed = 0;
  for (const lead of await findPendingQualified()) {
    try {
      const result = await post("uploadClickConversions", qualifiedPayload(lead, customerId(), actionId, process.env.GOOGLE_ADS_CURRENCY || "CAD"));
      if (!result.ok) {
        failed++;
        console.warn("[ads_qualified_conversion]", result.detail);
        continue;
      }
      await pool.query(
        `UPDATE applications SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('ad_qualified_conversion_uploaded_at', now()::text) WHERE id::text = $1`,
        [lead.applicationId],
      );
      uploaded++;
    } catch (error) {
      failed++;
      logError("google_ads_qualified_upload_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { configured: true, uploaded, failed };
}

export async function findPendingRetractions(limit = 200): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text AS id
       FROM applications
      WHERE silo = 'BF'
        AND lower(COALESCE(pipeline_state, '')) = ANY($1)
        AND (metadata->'ad_submit_conversion_uploaded_at') IS NOT NULL
        AND (metadata->'ad_qualified_conversion_uploaded_at') IS NULL
        AND (metadata->'ad_submit_conversion_retracted_at') IS NULL
      LIMIT $2`,
    [CLOSED_STATES, limit],
  );
  return rows.map((row) => row.id);
}

export async function retractClosedSubmitConversions(): Promise<{ configured: boolean; retracted: number; failed: number }> {
  if (!submitConversionsConfigured()) return { configured: false, retracted: 0, failed: 0 };
  const actionId = digits(process.env.GOOGLE_ADS_SUBMIT_CONVERSION_ACTION_ID);
  let retracted = 0;
  let failed = 0;
  for (const id of await findPendingRetractions()) {
    try {
      const result = await post("uploadConversionAdjustments", retractionPayload([id], customerId(), actionId));
      if (!result.ok) {
        failed++;
        console.warn("[ads_retraction]", result.detail);
        continue;
      }
      await pool.query(
        `UPDATE applications SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('ad_submit_conversion_retracted_at', now()::text) WHERE id::text = $1`,
        [id],
      );
      retracted++;
    } catch (error) {
      failed++;
      logError("google_ads_retraction_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { configured: true, retracted, failed };
}

export async function conversionStatus(): Promise<Record<string, { configured: boolean; sent: number; waiting: number }>> {
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE (metadata->'ad_submit_conversion_uploaded_at') IS NOT NULL)::text AS submit_sent,
       count(*) FILTER (WHERE submitted_at IS NOT NULL AND ${CLICK_ID_SQL} IS NOT NULL
                          AND (metadata->'ad_submit_conversion_uploaded_at') IS NULL)::text AS submit_waiting,
       count(*) FILTER (WHERE (metadata->'ad_qualified_conversion_uploaded_at') IS NOT NULL)::text AS qualified_sent,
       count(*) FILTER (WHERE lower(COALESCE(pipeline_state,'')) = ANY($1) AND ${CLICK_ID_SQL} IS NOT NULL
                          AND (metadata->'ad_qualified_conversion_uploaded_at') IS NULL)::text AS qualified_waiting,
       count(*) FILTER (WHERE (metadata->'ad_conversion_uploaded_at') IS NOT NULL)::text AS funded_sent,
       count(*) FILTER (WHERE pipeline_state IN ('Accepted','Funded') AND ${CLICK_ID_SQL} IS NOT NULL
                          AND (metadata->'ad_conversion_uploaded_at') IS NULL)::text AS funded_waiting,
       count(*) FILTER (WHERE (metadata->'ad_submit_conversion_retracted_at') IS NOT NULL)::text AS retracted_sent
       FROM applications
      WHERE silo = 'BF'`,
    [QUALIFIED_STATES],
  );
  const row = rows[0] ?? {};
  const count = (key: string) => Number(row[key] ?? 0);
  return {
    submitted: { configured: submitConversionsConfigured(), sent: count("submit_sent"), waiting: count("submit_waiting") },
    qualified: { configured: qualifiedConfigured(), sent: count("qualified_sent"), waiting: count("qualified_waiting") },
    funded: { configured: conversionsConfigured(), sent: count("funded_sent"), waiting: count("funded_waiting") },
    retracted: { configured: submitConversionsConfigured(), sent: count("retracted_sent"), waiting: 0 },
  };
}
