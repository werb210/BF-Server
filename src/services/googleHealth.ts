// BF_SERVER_GOOGLE_HEALTH_v705
// Live checks against Google, shown on portal Settings > Runtime Verification and run hourly.
// Any failure texts and emails the alert recipients (once, then once a day while it stays broken).
import { createHash } from "node:crypto";
import { pool } from "../db.js";
import { accessToken } from "./googleAdsConversions.js";
import { ingestConversions } from "./googleDataManager.js";
import { ga4Configured, runGa4Report } from "./ga4Service.js";
import { sendSMS } from "./smsService.js";
import { sendViaGraph } from "./email/graphSendService.js";

export type HealthStatus = "ok" | "fail" | "off";
export type HealthCheck = { key: string; label: string; status: HealthStatus; detail: string };
export type HealthReport = { checkedAt: string; checks: HealthCheck[] };

const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

async function check(key: string, label: string, fn: () => Promise<{ status: HealthStatus; detail: string }>): Promise<HealthCheck> {
  try {
    return { key, label, ...(await fn()) };
  } catch (err) {
    return { key, label, status: "fail", detail: (err instanceof Error ? err.message : String(err)).slice(0, 400) };
  }
}

export async function runGoogleHealthChecks(fetchImpl: typeof fetch = fetch): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  checks.push(await check("google_login", "Google login (Google Ads + Data Manager)", async () => {
    if (!process.env.GOOGLE_ADS_REFRESH_TOKEN) return { status: "fail", detail: "GOOGLE_ADS_REFRESH_TOKEN is not set" };
    const token = await accessToken();
    const r = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    const j: any = await r.json().catch(() => ({}));
    const scope = String(j?.scope ?? "");
    const missing = ["auth/adwords", "auth/datamanager"].filter((s) => !scope.includes(s));
    return missing.length
      ? { status: "fail", detail: `the saved Google login is missing: ${missing.join(", ")}` }
      : { status: "ok", detail: "signed in with Google Ads and Data Manager access" };
  }));
  checks.push(await check("conversion_test", "Conversion upload test (Google checks it, nothing is recorded)", async () => {
    const action = String(process.env.GOOGLE_ADS_SUBMIT_CONVERSION_ACTION_ID ?? "");
    if (!digits(action)) return { status: "fail", detail: "GOOGLE_ADS_SUBMIT_CONVERSION_ACTION_ID is not set" };
    const r = await ingestConversions(action, [{
      transactionId: `healthcheck-${Date.now()}`, at: new Date().toISOString(), value: 1,
      userIdentifiers: [{ hashedEmail: sha256("healthcheck@boreal.financial") }],
    }], true, fetchImpl);
    return r.ok
      ? { status: "ok", detail: "Google accepted a test conversion for Application Submitted" }
      : { status: "fail", detail: `Google rejected the test conversion (${r.status}): ${r.detail}` };
  }));
  checks.push(await check("ads_reporting", "Google Ads reporting", async () => {
    const cid = digits(process.env.GOOGLE_ADS_CUSTOMER_ID);
    if (!cid || !process.env.GOOGLE_ADS_DEVELOPER_TOKEN) return { status: "fail", detail: "Google Ads customer id or developer token is not set" };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await accessToken()}`,
      "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
      "Content-Type": "application/json",
    };
    const lc = digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
    if (lc) headers["login-customer-id"] = lc;
    const r = await fetchImpl(`https://googleads.googleapis.com/v24/customers/${cid}/googleAds:search`, {
      method: "POST", headers, body: JSON.stringify({ query: "SELECT customer.id FROM customer LIMIT 1" }),
    });
    const responseText = await r.text().catch(() => "");
    return r.ok ? { status: "ok", detail: "campaign data can be read" } : { status: "fail", detail: `Google Ads replied ${r.status}: ${responseText.slice(0, 300)}` };
  }));
  checks.push(await check("submissions_sent", "Ad-click applications sent to Google", async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM applications
        WHERE silo = 'BF'
          AND submitted_at < now() - interval '24 hours'
          AND submitted_at > now() - interval '30 days'
          AND COALESCE(NULLIF(metadata->'attribution'->>'gclid',''), NULLIF(metadata->'attribution'->>'gbraid',''), NULLIF(metadata->'attribution'->>'wbraid','')) IS NOT NULL
          AND (metadata->'ad_submit_conversion_uploaded_at') IS NULL`,
    );
    const n = Number(rows[0]?.n ?? 0);
    return n > 0
      ? { status: "fail", detail: `${n} application(s) from ad clicks, submitted more than a day ago, have not reached Google` }
      : { status: "ok", detail: "every application from an ad click in the last 30 days was sent to Google" };
  }));
  checks.push(await check("ga4", "Google Analytics (GA4)", async () => {
    if (!ga4Configured()) return { status: "off", detail: "GA4 is not set up on the server" };
    const r: any = await runGa4Report(1);
    if (!r) return { status: "fail", detail: "GA4 returned no data" };
    if (r.error) return { status: "fail", detail: String(r.error).slice(0, 300) };
    return { status: "ok", detail: "analytics data can be read" };
  }));
  return { checkedAt: new Date().toISOString(), checks };
}

let latest: HealthReport | null = null;
let lastAlertAt = 0;
let lastFailingKeys = "";
const ALERT_REPEAT_MS = 24 * 60 * 60_000;

export async function getGoogleHealth(refresh: boolean): Promise<HealthReport> {
  if (!refresh && latest && Date.now() - Date.parse(latest.checkedAt) < 10 * 60_000) return latest;
  latest = await runGoogleHealthChecks();
  return latest;
}

function listFrom(value: string | undefined, fallback: string): string[] {
  return String(value || fallback).split(",").map((s) => s.trim()).filter(Boolean);
}

export async function alertIfFailing(report: HealthReport, now = Date.now()): Promise<boolean> {
  const failing = report.checks.filter((c) => c.status === "fail");
  if (!failing.length) { lastAlertAt = 0; lastFailingKeys = ""; return false; }
  const keys = failing.map((c) => c.key).sort().join(",");
  if (keys === lastFailingKeys && now - lastAlertAt < ALERT_REPEAT_MS) return false;
  lastAlertAt = now;
  lastFailingKeys = keys;
  const summary = failing.map((c) => c.label).join("; ");
  const phones = listFrom(process.env.GOOGLE_HEALTH_ALERT_PHONES, process.env.LEAD_ALERT_SMS_TO ?? "");
  const emails = listFrom(process.env.GOOGLE_HEALTH_ALERT_EMAILS, "todd.w@boreal.financial,andrew.p@boreal.financial");
  for (const to of phones) {
    try { await sendSMS(to, `Boreal: Google check FAILED - ${summary}. Details: portal Settings > Runtime Verification.`); }
    catch (err) { console.warn("[google_health] sms alert failed", { message: err instanceof Error ? err.message : String(err) }); }
  }
  try {
    await sendViaGraph({
      to: emails,
      subject: `Google check failed: ${summary}`,
      bodyText: [
        "A Google Ads / Analytics check failed on the Boreal server.", "",
        ...failing.map((c) => `- ${c.label}: ${c.detail}`), "",
        "See portal Settings > Runtime Verification. You'll get one reminder a day while it stays broken.",
      ].join("\n"),
    });
  } catch (err) {
    console.warn("[google_health] email alert failed", { message: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

export function startGoogleHealthMonitor(): { stop: () => void } {
  const tick = async () => {
    try { await alertIfFailing(await getGoogleHealth(true)); }
    catch (err) { console.warn("[google_health] tick failed", { message: err instanceof Error ? err.message : String(err) }); }
  };
  const first = setTimeout(() => { void tick(); }, 5 * 60_000);
  const timer = setInterval(() => { void tick(); }, 60 * 60_000);
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

export function __resetGoogleHealthForTests(): void { latest = null; lastAlertAt = 0; lastFailingKeys = ""; }
