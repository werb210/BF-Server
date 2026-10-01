// BF_SERVER_DATA_MANAGER_v703
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/googleAdsConversions.js", () => ({ accessToken: async () => "tok-v703" }));

import { buildIngestBody, ingestConversions, DATA_MANAGER_INGEST_URL } from "../services/googleDataManager.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  process.env.GOOGLE_ADS_CUSTOMER_ID = "258-685-7341";
  delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  process.env.GOOGLE_ADS_SUBMIT_CONVERSION_ACTION_ID = "7700001";
  process.env.GOOGLE_ADS_REFRESH_TOKEN = "rt";
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "dev";
  process.env.LEAD_ALERT_SMS_TO = "+15555550100";
  delete process.env.GOOGLE_HEALTH_ALERT_PHONES;
});

describe("Data Manager conversion upload", () => {
  it("builds Google's ingest request: account, action, click id, commission value, hashed user data", () => {
    const body = buildIngestBody("7700001", [{ transactionId: "app-1-submit", clickField: "gclid", clickId: "G1", at: "2026-10-01T12:00:00Z", value: 4500.004, userIdentifiers: [{ hashedEmail: "a".repeat(64) }, { hashedPhoneNumber: "b".repeat(64) }] }]);
    expect(body.destinations[0]).toEqual({ operatingAccount: { accountType: "GOOGLE_ADS", accountId: "2586857341" }, loginAccount: { accountType: "GOOGLE_ADS", accountId: "2586857341" }, productDestinationId: "7700001" });
    expect(body.encoding).toBe("HEX");
    expect(body.events[0]).toEqual({ transactionId: "app-1-submit", eventTimestamp: "2026-10-01T12:00:00.000Z", eventSource: "WEB", adIdentifiers: { gclid: "G1" }, conversionValue: 4500, currency: "CAD", userData: { userIdentifiers: [{ emailAddress: "a".repeat(64) }, { phoneNumber: "b".repeat(64) }] } });
  });
  it("posts to the Data Manager API with the Google login and reports Google's field errors", async () => {
    const calls: any[] = [];
    const ok = await ingestConversions("7700001", [{ transactionId: "t", at: "2026-10-01", value: 0 }], false, (async (url: string, init: any) => { calls.push({ url, init }); return json(200, { requestId: "r1" }); }) as any);
    expect(ok).toMatchObject({ ok: true, requestId: "r1" });
    expect(calls[0].url).toBe(DATA_MANAGER_INGEST_URL);
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok-v703");
    const bad = await ingestConversions("7700001", [{ transactionId: "t", at: "2026-10-01", value: 0 }], false, (async () => json(400, { error: { message: "There was a problem with the request.", details: [{ fieldViolations: [{ field: "events.events[0]", description: "Email is not hex encoded." }] }] } })) as any);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("Email is not hex encoded.");
  });
});

describe("uploaders use Data Manager, not the retired Google Ads API import", () => {
  it("submit, funded and qualified all send through ingestConversions", () => {
    const conv = readFileSync("src/services/googleAdsConversions.ts", "utf8");
    expect(conv).toContain('await sendViaDataManager(p, "GOOGLE_ADS_SUBMIT_CONVERSION_ACTION_ID", `${p.applicationId}-submit`)');
    expect(conv).toContain('await sendViaDataManager(p, "GOOGLE_ADS_CONVERSION_ACTION_ID", p.applicationId)');
    expect(conv).not.toContain("const ok = await uploadOneSubmit(p);");
    expect(readFileSync("src/services/googleAdsLeadSignals.ts", "utf8")).toContain("const result = await ingestConversions(actionId,");
  });
});
