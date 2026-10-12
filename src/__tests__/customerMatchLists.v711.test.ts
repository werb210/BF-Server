// BF_SERVER_CUSTOMER_MATCH_LISTS_v711
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
const queries: Array<{ sql: string; params: unknown[] }> = [];
let savedList: string | null = null;
let applicantRows: any[] = [];
const ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const h = vi.hoisted(() => ({ tick: null as Promise<unknown> | null, fundedSyncs: 0 }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (/SELECT list_id FROM ads_customer_match_lists/.test(sql)) return { rows: savedList ? [{ list_id: savedList }] : [] };
    if (/INSERT INTO ads_customer_match_lists/.test(sql)) { savedList = String(params[1]); return { rows: [] }; }
    if (/WITH bf AS/.test(sql)) return { rows: applicantRows };
    // The client router's ownership checks: the signed-in client owns the application being deleted.
    if (/FROM applications WHERE lower\(id::text\) = ANY/.test(sql)) return { rows: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] };
    if (/WITH app_phones AS/.test(sql)) return { rows: [{ total: 1, mine: 1, known: 1 }] };
    if (/DELETE FROM applications/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: query, runQuery: query };
});
vi.mock("../services/googleAdsConversions.js", async (orig) => ({
  ...(await orig<any>()),
  accessToken: async () => "tok",
  uploadSubmitConversions: async () => ({ ok: 0 }),
  uploadFundedConversions: async () => ({ ok: 0 }),
}));
vi.mock("../observability/logger.js", async (orig) => ({ ...(await orig<any>()), logError: vi.fn() }));
// The hourly ad-conversion worker and its other stages.
vi.mock("../workers/claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<unknown>) => () => (h.tick = fn()) }));
vi.mock("../services/googleAdsAttribution.js", async (orig) => ({ ...(await orig<any>()), resolvePendingAdAttributions: async () => ({}) }));
vi.mock("../services/googleAdsEnhanced.js", async (orig) => ({ ...(await orig<any>()), syncCustomerMatch: async () => ({}) }));
vi.mock("../services/googleAdsLeadSignals.js", async (orig) => ({ ...(await orig<any>()), retractClosedSubmitConversions: async () => ({}), uploadQualifiedConversions: async () => ({}) }));
vi.mock("../services/googleHealth.js", async (orig) => ({ ...(await orig<any>()), startGoogleHealthMonitor: () => ({ stop: () => undefined }) }));
vi.mock("../services/googleAudienceSync.js", async (orig) => ({ ...(await orig<any>()), syncAudiencesViaDataManager: async () => ({}) }));
vi.mock("../services/visitorAdLookup.js", async (orig) => ({ ...(await orig<any>()), resolveVisitorSessionAds: async () => ({}) }));
vi.mock("../services/customerMatchLists.js", async (orig) => ({
  ...(await orig<any>()),
  syncFundedList: async () => { h.fundedSyncs += 1; return { sent: 0, failed: 0 }; },
}));
import { createListBody, ensureUserList, LIST_NAMES, memberBody, sendApplicants } from "../services/customerMatchLists.js";
import clientRouter from "../routes/client/index.js";
import { startAdConversionWorker } from "../workers/adConversionWorker.js";
const env = { ...process.env };
beforeEach(() => { queries.length = 0; savedList = null; applicantRows = []; process.env.GOOGLE_ADS_CUSTOMER_ID = "258-685-7341"; process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = ""; });
afterEach(() => { process.env = { ...env }; });
function fakeFetch(handlers: Array<(url: string, init: any) => Response | null>) {
  const calls: Array<{ url: string; init: any }> = [];
  const f = vi.fn(async (url: any, init: any = {}) => { calls.push({ url: String(url), init }); for (const handler of handlers) { const result = handler(String(url), init); if (result) return result; } return new Response("{}", { status: 200 }); });
  return { f: f as unknown as typeof fetch, calls };
}
describe("server-created Customer Match lists", () => {
  it("uses a first-party contact-info list", () => { const body = createListBody("applicants"); expect(body.displayName).toBe(LIST_NAMES.applicants); expect(body.ingestedUserListInfo).toEqual({ contactIdInfo: { dataSourceType: "DATA_SOURCE_TYPE_FIRST_PARTY" }, uploadKeyTypes: ["CONTACT_ID"] }); expect(body.membershipDuration).toBe("46656000s"); });
  it("creates once and remembers the ID", async () => {
    const { f, calls } = fakeFetch([(url) => url.endsWith("/userLists?pageSize=1000") ? new Response(JSON.stringify({ userLists: [] }), { status: 200 }) : null, (url, init) => url.endsWith("/userLists") && init.method === "POST" ? new Response(JSON.stringify({ id: "9988" }), { status: 200 }) : null]);
    expect(await ensureUserList("applicants", f)).toBe("9988"); expect(calls.find((call) => call.init.method === "POST")!.init.headers["login-account"]).toBe("accountTypes/GOOGLE_ADS/accounts/2586857341"); expect((await ensureUserList("applicants", fakeFetch([]).f))).toBe("9988");
  });
  it("reuses a list in Google by name", async () => { const { f, calls } = fakeFetch([(url) => url.endsWith("?pageSize=1000") ? new Response(JSON.stringify({ userLists: [{ id: "4455", displayName: LIST_NAMES.funded }] }), { status: 200 }) : null]); expect(await ensureUserList("funded", f)).toBe("4455"); expect(calls.some((call) => call.init.method === "POST")).toBe(false); });
  it("uses explicit or unspecified consent", () => { const body = memberBody("1", [{ contactId: "a", ids: [{ hashedEmail: "e" }], consented: true }, { contactId: "b", ids: [{ hashedPhoneNumber: "p" }], consented: false }]); expect(body.audienceMembers[0].consent.adUserData).toBe("CONSENT_GRANTED"); expect(body.audienceMembers[1].consent.adUserData).toBe("CONSENT_STATUS_UNSPECIFIED"); });
  it("sends only selected applicants and records them", async () => { savedList = "777"; applicantRows = [{ contact_id: "11111111-1111-4111-8111-111111111111", email: "a@x.com", phone: null, consented: true }, { contact_id: "22222222-2222-4222-8222-222222222222", email: "b@x.com", phone: "4035550101", consented: false }]; const { f, calls } = fakeFetch([]); expect(await sendApplicants(["22222222-2222-4222-8222-222222222222"], f)).toMatchObject({ sent: 1, failed: 0, skipped: 0 }); expect(JSON.parse(calls.find((call) => call.url.endsWith("audienceMembers:ingest"))!.init.body).audienceMembers).toHaveLength(1); expect(queries.some((query) => /INSERT INTO ads_audience_members/.test(query.sql))).toBe(true); });
});
describe("query and wiring", () => {
  it("includes applicants and excludes opt-outs", async () => {
    savedList = "777";
    await sendApplicants(["22222222-2222-4222-8222-222222222222"], fakeFetch([]).f);
    const audience = queries.find((q) => /WITH bf AS/.test(q.sql))!.sql;
    expect(audience).toContain("a.submitted_at IS NOT NULL");
    expect(audience).toContain("c.consent_source = 'CBF application terms'");
    expect(audience).toContain("COALESCE(c.marketing_opt_out, false) = false");
  });
  it("opts out deleted accounts", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/client", clientRouter);
    const token = "Bearer " + jwt.sign({ sub: "client:+15875550123", role: "client", phone: "+15875550123", isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
    const r = await request(app).post("/api/client/account/delete").set("Authorization", token).send({ applicationId: ACCOUNT });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, deleted: true });
    const sqls = queries.map((q) => q.sql);
    const optOut = queries.find((q) => /UPDATE contacts SET marketing_opt_out = true/.test(q.sql))!;
    expect(optOut.sql).toContain("tags = array(SELECT DISTINCT unnest(COALESCE(tags,'{}') || ARRAY['account_deleted']))");
    expect(optOut.params).toEqual([ACCOUNT]);
    // Opted out before the application (and the contact link) is deleted.
    expect(sqls.findIndex((s) => /UPDATE contacts SET marketing_opt_out/.test(s))).toBeLessThan(sqls.findIndex((s) => /DELETE FROM applications/.test(s)));
  });
  it("automatically syncs funded clients", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    h.fundedSyncs = 0;
    const worker = startAdConversionWorker({} as any);
    await h.tick;
    worker.stop();
    expect(h.fundedSyncs).toBe(1);
    expect(log.mock.calls.some((c) => c[0] === "[ads_conversion] tick" && String(c[1]).includes('"fundedList":{"sent":0,"failed":0}'))).toBe(true);
    log.mockRestore();
  });
});
