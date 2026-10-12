// BF_SERVER_INTERNAL_CALLER_v54
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken } from "../../__tests__/helpers/staffRouterApp.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));

const USER = "12345678-1234-4123-8123-123456789012";
const resolve = async (body: Record<string, unknown>) => {
  const app = mountRouter((await import("../voiceCalls.js")).default, "/api/voice");
  return request(app).post("/api/voice/resolve-caller").set("Authorization", `Bearer ${staffToken()}`).send(body);
};
// Lookups the route makes, leaving out the auth middleware's own users-by-id profile read.
const routeQueries = () => queryMock.mock.calls.filter((c) => !/SELECT id, email, role, silo, silos FROM users/.test(String(c[0])));

beforeEach(() => {
  queryMock.mockReset().mockImplementation(answerBySql([]));
});

describe("resolving a portal-to-portal caller", () => {
  it("recognises the client:<uuid> identity a staff ring arrives as, and looks it up in users", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM users WHERE id::text/, { rows: [{ user_id: USER, first_name: "Pat", last_name: "Lee" }] }]]));
    const res = await resolve({ phone: `client:${USER}` });
    expect(res.body).toEqual({ ok: true, matched: true, isStaff: true, name: "Pat Lee", userId: USER });
    expect(callsMatching(queryMock, /FROM users WHERE id::text/)[0][1]).toEqual([USER]);
    expect(callsMatching(queryMock, /FROM contacts/)).toHaveLength(0);
  });

  it("never mines a phone number out of a UUID", async () => {
    // A UUID has enough digits to produce a plausible 10-digit number, which
    // matched no contact and surfaced as "Unknown caller" after a nonsense
    // lookup rather than a skipped one.
    const res = await resolve({ phone: `client:${USER}` });
    expect(res.body).toEqual({ ok: true, matched: false, isStaff: false, name: null });
    expect(callsMatching(queryMock, /FROM contacts/)).toHaveLength(0);
    for (const [, params] of routeQueries()) {
      expect(params as unknown[]).not.toContain(USER.replace(/[^0-9]/g, "").slice(-10));
    }
  });

  it("keeps the existing conference-based internal resolution", async () => {
    queryMock.mockImplementation(answerBySql([[/AND c\.direction = 'internal'/, { rows: [{ user_id: "u-1", first_name: "Ida", last_name: "" }] }]]));
    const res = await resolve({ phone: "", conferenceFriendly: "int_1" });
    expect(res.body).toMatchObject({ matched: true, isStaff: true, name: "Ida" });
  });

  it("still resolves an ordinary inbound number through contacts", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM contacts c/, { rows: [{ contact_id: "c-5", name: "Ord Inary", company: "" }] }]]));
    const res = await resolve({ phone: "+14035550155" });
    expect(res.body).toMatchObject({ matched: true, isStaff: false, name: "Ord Inary", contactId: "c-5" });
    expect(callsMatching(queryMock, /FROM contacts c/)[0][1]).toEqual(["4035550155", "BF"]);
  });
});
