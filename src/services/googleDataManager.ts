// BF_SERVER_DATA_MANAGER_v703
// Google Ads conversions go through the Data Manager API. Since 2026-06-15 the Google Ads API
// no longer accepts offline conversion imports from new adopters, which is why Google Ads showed
// "No attempted imports" for Application Submitted. Uses the same Google login (refresh token),
// which now carries both the adwords and datamanager scopes.
import { accessToken } from "./googleAdsConversions.js";
import type { UserIdentifier } from "./googleAdsEnhanced.js";

export const DATA_MANAGER_INGEST_URL = "https://datamanager.googleapis.com/v1/events:ingest";
const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");

export type DmConversion = {
  transactionId: string;
  clickField?: "gclid" | "gbraid" | "wbraid";
  clickId?: string | null;
  at: string;
  value: number;
  userIdentifiers?: UserIdentifier[];
};

// Value sent to Google = estimated commission (Todd 2026-10-01).
// BF_SERVER_COMMISSION_DEFAULT_2PCT_v729 - Boreal's default commission is 2% (Todd
// 2026-10-03); it was 3% here, in the Ads Story and in both Monday emails. A lender's
// own rate applies per deal where the deal is known (Dashboard, Reports).
export function commissionRate(): number {
  const r = Number(process.env.GOOGLE_ADS_COMMISSION_RATE ?? "0.02");
  return Number.isFinite(r) && r > 0 && r < 1 ? r : 0.02;
}

export function buildIngestBody(actionId: string, events: DmConversion[], validateOnly = false) {
  const customerId = digits(process.env.GOOGLE_ADS_CUSTOMER_ID);
  const loginId = digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || customerId;
  const currency = process.env.GOOGLE_ADS_CURRENCY || "CAD";
  return {
    destinations: [{
      operatingAccount: { accountType: "GOOGLE_ADS", accountId: customerId },
      loginAccount: { accountType: "GOOGLE_ADS", accountId: loginId },
      productDestinationId: digits(actionId),
    }],
    encoding: "HEX",
    validateOnly,
    events: events.map((e) => {
      const parsed = new Date(e.at);
      const ids = (e.userIdentifiers ?? []).map((u) => ("hashedEmail" in u ? { emailAddress: u.hashedEmail } : { phoneNumber: u.hashedPhoneNumber }));
      return {
        transactionId: e.transactionId,
        eventTimestamp: (Number.isNaN(parsed.getTime()) ? new Date() : parsed).toISOString(),
        eventSource: "WEB",
        ...(e.clickId ? { adIdentifiers: { [e.clickField ?? "gclid"]: e.clickId } } : {}),
        ...(e.value > 0 ? { conversionValue: Math.round(e.value * 100) / 100, currency } : {}),
        ...(ids.length ? { userData: { userIdentifiers: ids } } : {}),
      };
    }),
  };
}

export type DmResult = { ok: boolean; status: number; detail: string; requestId?: string };

export async function ingestConversions(actionId: string, events: DmConversion[], validateOnly = false, fetchImpl: typeof fetch = fetch): Promise<DmResult> {
  if (!digits(actionId)) return { ok: false, status: 0, detail: "conversion action id is not configured" };
  const token = await accessToken();
  const resp = await fetchImpl(DATA_MANAGER_INGEST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildIngestBody(actionId, events, validateOnly)),
  });
  const text = await resp.text().catch(() => "");
  let body: any = {};
  try { body = JSON.parse(text); } catch { /* keep raw text */ }
  if (!resp.ok) {
    const violations = (body?.error?.details ?? [])
      .flatMap((d: any) => d?.fieldViolations ?? [])
      .map((v: any) => `${v.field ?? ""} ${v.description ?? v.reason ?? ""}`.trim());
    const detail = [String(body?.error?.message ?? text).slice(0, 300), ...violations].filter(Boolean).join(" | ");
    return { ok: false, status: resp.status, detail: detail.slice(0, 500) };
  }
  const warnings = (body?.fieldWarnings ?? []).map((w: any) => w?.description ?? w?.reason).filter(Boolean);
  return { ok: true, status: resp.status, detail: warnings.length ? `accepted with warnings: ${warnings.join("; ")}` : "accepted", requestId: body?.requestId };
}
