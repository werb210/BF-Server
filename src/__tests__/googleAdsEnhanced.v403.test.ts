// BF_SERVER_ADS_ENHANCED_v403
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";
import { customerMatchEnabled, customerMatchOperations, normalizePhone, syncCustomerMatch, userIdentifiersFor } from "../services/googleAdsEnhanced.js";
import { qualifiedPayload } from "../services/googleAdsLeadSignals.js";

const h = vi.hoisted(() => ({ query: vi.fn(), ingest: vi.fn(async () => ({ ok: true, status: 200, detail: "" })) }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../services/googleDataManager.js", async (orig) => ({ ...(await orig<typeof import("../services/googleDataManager.js")>()), ingestConversions: h.ingest }));
// The worker's own scheduling: run the tick body directly, no Google health timers.
vi.mock("../workers/claim.js", async (orig) => ({ ...(await orig<typeof import("../workers/claim.js")>()), claimedTick: (_name: string, fn: () => Promise<void>) => fn }));
vi.mock("../services/googleHealth.js", async (orig) => ({ ...(await orig<typeof import("../services/googleHealth.js")>()), startGoogleHealthMonitor: () => ({ stop: () => undefined }) }));
vi.mock("../services/googleAdsEnhanced.js", async (orig) => {
  const real = await orig<typeof import("../services/googleAdsEnhanced.js")>();
  const { vi: v } = await import("vitest");
  return { ...real, syncCustomerMatch: v.fn(real.syncCustomerMatch) };
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const env = { ...process.env };
const ADS_ENV = { GOOGLE_ADS_DEVELOPER_TOKEN: "d", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "s", GOOGLE_ADS_REFRESH_TOKEN: "r", GOOGLE_ADS_CUSTOMER_ID: "2586857341" };
beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([])); h.ingest.mockClear(); });
afterEach(() => { process.env = { ...env }; });

describe("enhanced conversions for leads", () => {
  it("sends the hashed email only with consent, and never the phone (v806)", () => {
    expect(userIdentifiersFor(" Ann@Acme.com ", "(403) 555-1234", true)).toEqual([
      { hashedEmail: sha("ann@acme.com") },
    ]);
    expect(userIdentifiersFor("ann@acme.com", "4035551234", false)).toEqual([]);
    expect(userIdentifiersFor("ann@acme.com", "4035551234", undefined)).toEqual([]);
    expect(userIdentifiersFor("ann@acme.com", null, "true")).toEqual([{ hashedEmail: sha("ann@acme.com") }]);
  });

  it("normalizes North American phones to E.164", () => {
    expect(normalizePhone("403-555-1234")).toBe("+14035551234");
    expect(normalizePhone("+1 (403) 555-1234")).toBe("+14035551234");
    expect(normalizePhone("123")).toBe("");
  });

  it("identifiers ride on qualified uploads", () => {
    const body: any = qualifiedPayload({
      applicationId: "a", clickId: "G", clickField: "gclid", value: 0,
      at: "2026-09-22T00:00:00Z", userIdentifiers: [{ hashedEmail: "h" }],
    }, "1", "2", "CAD");
    expect(body.conversions[0].userIdentifiers).toEqual([{ hashedEmail: "h" }]);
  });

  it("submitted and funded uploads carry the identifiers of a consenting applicant, and only theirs", async () => {
    Object.assign(process.env, ADS_ENV, { GOOGLE_ADS_SUBMIT_CONVERSION_ACTION_ID: "111", GOOGLE_ADS_CONVERSION_ACTION_ID: "222" });
    const row = (id: string, consent: string) => ({ id, gclid: "G-" + id, click_field: "gclid", value: "1000", submitted_at: "2026-09-22T00:00:00Z", funded_at: "2026-09-22T00:00:00Z", contact_email: "Ann@Acme.com", contact_phone: "4035551234", ad_consent: consent });
    h.query.mockImplementation(answerBySql([[/FROM applications\s+WHERE silo = 'BF'/, { rows: [row("yes", "true"), row("no", "false")] }]]));
    const { uploadSubmitConversions, uploadFundedConversions } = await import("../services/googleAdsConversions.js");
    await uploadSubmitConversions();
    await uploadFundedConversions();
    const sent = h.ingest.mock.calls.map((c: any[]) => c[1][0]);
    const byTx = Object.fromEntries(sent.map((e: any) => [e.transactionId, e.userIdentifiers]));
    const ann = [{ hashedEmail: sha("ann@acme.com") }]; // BF_SERVER_v806_NO_PHONE_TO_ADS
    expect(byTx).toEqual({ "yes-submit": ann, "no-submit": [], yes: ann, no: [] });
    // Both lookups read the applicant's consent.
    const lookups = callsMatching(h.query, /FROM applications\s+WHERE silo = 'BF'/);
    expect(lookups).toHaveLength(2);
    for (const [sql] of lookups) expect(sqlText(sql)).toContain("AS ad_consent,");
  });
});

describe("Customer Match upload", () => {
  it("is a full weekly refresh: remove everyone, then add the current funded clients", () => {
    const operations: any[] = customerMatchOperations([[{ hashedEmail: "a" }], [{ hashedPhoneNumber: "b" }]]);
    expect(operations[0]).toEqual({ removeAll: true });
    expect(operations[1]).toEqual({ create: { userIdentifiers: [{ hashedEmail: "a" }] } });
    expect(operations).toHaveLength(3);
  });

  it("is opt-in", async () => {
    Object.assign(process.env, ADS_ENV);
    delete process.env.GOOGLE_ADS_CUSTOMER_MATCH_ENABLED;
    expect(customerMatchEnabled()).toBe(false);
    expect(await syncCustomerMatch(true)).toEqual({ enabled: false, ran: false });
    expect(h.query).not.toHaveBeenCalled();
    process.env.GOOGLE_ADS_CUSTOMER_MATCH_ENABLED = "TRUE";
    expect(customerMatchEnabled()).toBe(true);
  });

  it("leaves out clients who opted out of marketing", async () => {
    h.query.mockImplementation(answerBySql([[/FROM applications a JOIN contacts c/, { rows: [{ email: "a@x.com", phone: null }, { email: "a@x.com", phone: null }] }]]));
    const { fundedClientIdentifiers } = await import("../services/googleAdsEnhanced.js");
    expect(await fundedClientIdentifiers()).toEqual([[{ hashedEmail: sha("a@x.com") }]]);
    const [sql] = callsMatching(h.query, /FROM applications a JOIN contacts c/)[0]!;
    expect(sqlText(sql)).toContain("COALESCE(c.marketing_opt_out, false) = false");
  });

  it("runs from the hourly worker", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { startAdConversionWorker } = await import("../workers/adConversionWorker.js");
      const worker = startAdConversionWorker({} as any);
      await vi.waitFor(() => expect(log.mock.calls.some((c: unknown[]) => c[0] === "[ads_conversion] tick")).toBe(true));
      worker.stop();
      expect(syncCustomerMatch).toHaveBeenCalled();
      const line = JSON.parse(String(log.mock.calls.find((c: unknown[]) => c[0] === "[ads_conversion] tick")![1]));
      expect(line.customerMatch).toEqual({ enabled: false, ran: false });
    } finally {
      log.mockRestore();
    }
  });
});
