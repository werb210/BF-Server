// BF_SERVER_CUSTOMER_MATCH_LISTS_v711
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const queries: Array<{ sql: string; params: unknown[] }> = [];
let savedList: string | null = null;
let applicantRows: any[] = [];
vi.mock("../db.js", () => ({ pool: { query: vi.fn(async (sql: string, params: unknown[] = []) => {
  queries.push({ sql, params });
  if (/SELECT list_id FROM ads_customer_match_lists/.test(sql)) return { rows: savedList ? [{ list_id: savedList }] : [] };
  if (/INSERT INTO ads_customer_match_lists/.test(sql)) { savedList = String(params[1]); return { rows: [] }; }
  if (/WITH bf AS/.test(sql)) return { rows: applicantRows };
  return { rows: [] };
}) } }));
vi.mock("../services/googleAdsConversions.js", () => ({ accessToken: async () => "tok" }));
vi.mock("../observability/logger.js", () => ({ logError: vi.fn() }));
import { createListBody, ensureUserList, LIST_NAMES, memberBody, sendApplicants } from "../services/customerMatchLists.js";
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
  const service = readFileSync("src/services/customerMatchLists.ts", "utf8");
  it("includes applicants and excludes opt-outs", () => { expect(service).toContain("a.submitted_at IS NOT NULL"); expect(service).toContain("c.consent_source = 'CBF application terms'"); expect(service).toContain("COALESCE(c.marketing_opt_out, false) = false"); });
  it("opts out deleted accounts", () => expect(readFileSync("src/routes/client/index.ts", "utf8")).toContain("SET marketing_opt_out = true, tags = array(SELECT DISTINCT unnest(COALESCE(tags,'{}') || ARRAY['account_deleted']))"));
  it("automatically syncs funded clients", () => expect(readFileSync("src/workers/adConversionWorker.ts", "utf8")).toContain(".syncFundedList()"));
});
