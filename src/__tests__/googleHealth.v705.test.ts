// BF_SERVER_GOOGLE_HEALTH_v705
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pending: 0, ga4: false, sms: [] as string[], emails: [] as unknown[] }));
vi.mock("../services/googleAdsConversions.js", () => ({ accessToken: async () => "tok-v703" }));
vi.mock("../db.js", () => ({ pool: { query: async (sql: string) => (sql.includes("ad_submit_conversion_uploaded_at") ? { rows: [{ n: state.pending }] } : { rows: [] }) } }));
vi.mock("../services/ga4Service.js", () => ({ ga4Configured: () => state.ga4, runGa4Report: async () => ({ configured: true, days: 1, error: "quota exhausted" }) }));
vi.mock("../services/smsService.js", () => ({ sendSMS: async (to: string) => { state.sms.push(to); } }));
vi.mock("../services/email/graphSendService.js", () => ({ sendViaGraph: async (input: unknown) => { state.emails.push(input); return { ok: true }; } }));

import { DATA_MANAGER_INGEST_URL } from "../services/googleDataManager.js";
import { alertIfFailing, runGoogleHealthChecks, __resetGoogleHealthForTests } from "../services/googleHealth.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  process.env.GOOGLE_ADS_CUSTOMER_ID = "258-685-7341";
  delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  process.env.GOOGLE_ADS_SUBMIT_CONVERSION_ACTION_ID = "7700001";
  process.env.GOOGLE_ADS_REFRESH_TOKEN = "rt";
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "dev";
  process.env.LEAD_ALERT_SMS_TO = "+15555550100";
  delete process.env.GOOGLE_HEALTH_ALERT_PHONES;
  state.pending = 0; state.ga4 = false; state.sms = []; state.emails = [];
  __resetGoogleHealthForTests();
});

describe("Google health checks", () => {
  const google = (scope: string, dmStatus = 200) => (async (url: string, init?: any) => {
    if (url.includes("tokeninfo")) return json(200, { scope });
    if (url === DATA_MANAGER_INGEST_URL) { expect(JSON.parse(init.body).validateOnly).toBe(true); return dmStatus === 200 ? json(200, { requestId: "x" }) : json(dmStatus, { error: { message: "PERMISSION_DENIED" } }); }
    if (url.includes("googleAds:search")) return json(200, { results: [] });
    return json(404, {});
  }) as any;
  it("all green when the login has both permissions and Google accepts the test upload", async () => {
    const r = await runGoogleHealthChecks(google("https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager"));
    expect(Object.fromEntries(r.checks.map((c) => [c.key, c.status]))).toEqual({ google_login: "ok", conversion_test: "ok", ads_reporting: "ok", submissions_sent: "ok", ga4: "off" });
  });
  it("fails loudly when the login lacks Data Manager, Google rejects uploads, or applications are stuck", async () => {
    state.pending = 3; state.ga4 = true;
    const r = await runGoogleHealthChecks(google("https://www.googleapis.com/auth/adwords", 403));
    const byKey = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(byKey.google_login.status).toBe("fail");
    expect(byKey.google_login.detail).toContain("auth/datamanager");
    expect(byKey.conversion_test.status).toBe("fail");
    expect(byKey.submissions_sent.detail).toContain("3 application(s)");
    expect(byKey.ga4).toMatchObject({ status: "fail", detail: "quota exhausted" });
  });
  it("texts and emails on a new failure, then at most once a day while unchanged", async () => {
    const failing = { checkedAt: "", checks: [{ key: "conversion_test", label: "Conversion upload test", status: "fail" as const, detail: "x" }] };
    expect(await alertIfFailing(failing, 1_000)).toBe(true);
    expect(state.sms).toEqual(["+15555550100"]);
    expect((state.emails[0] as any).to).toEqual(["todd.w@boreal.financial", "andrew.p@boreal.financial"]);
    expect(await alertIfFailing(failing, 2_000)).toBe(false);
    expect(await alertIfFailing(failing, 1_000 + 24 * 60 * 60_000)).toBe(true);
  });
});

describe("health route and monitor are wired in", () => {
  it("serves /google-health and starts the hourly monitor", () => {
    expect(readFileSync("src/routes/_int.ts", "utf8")).toContain('router.get("/google-health", requireAuth');
    expect(readFileSync("src/workers/adConversionWorker.ts", "utf8")).toContain("startGoogleHealthMonitor()");
  });
});
