// BF_SERVER_ADS_AUDIENCES_v708
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";
import { buildAudienceBody, audienceLists, DATA_MANAGER_AUDIENCE_URL } from "../services/googleAudienceSync.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
// The worker's own scheduling: run the tick body directly, no Google health timers.
vi.mock("../workers/claim.js", async (orig) => ({ ...(await orig<typeof import("../workers/claim.js")>()), claimedTick: (_name: string, fn: () => Promise<void>) => fn }));
vi.mock("../services/googleHealth.js", async (orig) => ({ ...(await orig<typeof import("../services/googleHealth.js")>()), startGoogleHealthMonitor: () => ({ stop: () => undefined }) }));
vi.mock("../services/googleAudienceSync.js", async (orig) => {
  const real = await orig<typeof import("../services/googleAudienceSync.js")>();
  const { vi: v } = await import("vitest");
  return { ...real, syncAudiencesViaDataManager: v.fn(real.syncAudiencesViaDataManager) };
});

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); });
beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([])); });

describe("Customer Match through Data Manager", () => {
  it("uses the Data Manager audience endpoint, hashed identifiers, consent and the terms of service", () => {
    process.env.GOOGLE_ADS_CUSTOMER_ID = "258-685-7341";
    const body = buildAudienceBody("123", [[{ hashedEmail: "ab" }, { hashedPhoneNumber: "cd" }]]);
    expect(DATA_MANAGER_AUDIENCE_URL).toBe("https://datamanager.googleapis.com/v1/audienceMembers:ingest");
    expect(body.destinations[0].operatingAccount.accountId).toBe("2586857341");
    expect(body.destinations[0].productDestinationId).toBe("123");
    expect(body.audienceMembers[0].userData.userIdentifiers).toEqual([{ emailAddress: "ab" }, { phoneNumber: "cd" }]);
    expect(body.audienceMembers[0].consent.adUserData).toBe("CONSENT_GRANTED");
    expect(body.termsOfService.customerMatchTermsOfServiceStatus).toBe("ACCEPTED");
    expect(body.encoding).toBe("HEX");
  });
  it("does nothing until list IDs are set", () => {
    delete process.env.GOOGLE_ADS_CM_FUNDED_LIST_ID;
    delete process.env.GOOGLE_ADS_CM_QUALIFIED_LIST_ID;
    expect(audienceLists()).toEqual([]);
    process.env.GOOGLE_ADS_CM_FUNDED_LIST_ID = "999";
    expect(audienceLists()).toEqual([{ kind: "funded", listId: "999" }]);
  });

  it("only uploads people who consented", async () => {
    process.env.GOOGLE_ADS_CUSTOMER_ID = "2586857341";
    process.env.GOOGLE_ADS_CM_FUNDED_LIST_ID = "999";
    delete process.env.GOOGLE_ADS_CM_QUALIFIED_LIST_ID;
    h.query.mockImplementation(answerBySql([
      [/FROM applications a\s+JOIN contacts c/, { rows: [
        { contact_id: "c-yes", email: "yes@example.com", phone: "4035550100", consent: "true" },
        { contact_id: "c-no", email: "no@example.com", phone: "4035550101", consent: "false" },
        { contact_id: "c-unknown", email: "unknown@example.com", phone: null, consent: null },
      ] }],
    ]));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("oauth2.googleapis.com")
      ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })
      : new Response("{}", { status: 200 }))));
    const upload = vi.fn(async () => new Response("{}", { status: 200 }));
    const { syncAudiencesViaDataManager } = await import("../services/googleAudienceSync.js");
    expect(await syncAudiencesViaDataManager(upload as any)).toEqual({ funded: { sent: 1, failed: 0 } });
    const [url, init] = upload.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe(DATA_MANAGER_AUDIENCE_URL);
    expect(JSON.parse(init.body).audienceMembers).toHaveLength(1);
    expect(callsMatching(h.query, /INSERT INTO ads_audience_members/).map((c) => c[1])).toEqual([["999", "c-yes"]]);
  });

  it("runs from the conversion worker", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { startAdConversionWorker } = await import("../workers/adConversionWorker.js");
      const { syncAudiencesViaDataManager } = await import("../services/googleAudienceSync.js");
      const worker = startAdConversionWorker({} as any);
      await vi.waitFor(() => expect(log.mock.calls.some((c: unknown[]) => c[0] === "[ads_conversion] tick")).toBe(true));
      worker.stop();
      expect(syncAudiencesViaDataManager).toHaveBeenCalled();
      const line = JSON.parse(String(log.mock.calls.find((c: unknown[]) => c[0] === "[ads_conversion] tick")![1]));
      expect(line).toHaveProperty("audiences");
    } finally {
      log.mockRestore();
    }
  });
});

describe("visitors page count", () => {
  it("counts the website's pageview events", async () => {
    const { visitorsReport } = await import("../routes/marketing/adsStory.js");
    await visitorsReport(30, "all");
    const [sql] = callsMatching(h.query, /FROM visitor_sessions s/)[0]!;
    expect(sqlText(sql)).toContain("e.event_type IN ('page_view', 'pageview')");
  });
});
