// BF_SERVER_STAFF_CALLER_RESOLVE_v1
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));

const resolve = async (body: Record<string, unknown>) => {
  const app = mountRouter((await import("../routes/voiceCalls.js")).default, "/api/voice");
  return request(app).post("/api/voice/resolve-caller").set("Authorization", `Bearer ${staffToken()}`).send(body);
};
const STAFF_DIRECTORY = /FROM users\s+WHERE active = true/;

beforeEach(() => {
  queryMock.mockReset().mockImplementation(answerBySql([]));
});

describe("staff caller resolution", () => {
  it("falls back from contacts to the users directory by phone", async () => {
    // Only the lookup after contacts knows this number (the colleague-first check misses).
    let directory = 0;
    queryMock.mockImplementation(answerBySql([
      [STAFF_DIRECTORY, () => (++directory === 2 ? { rows: [{ user_id: "u-7", first_name: "Kim", last_name: "Doe" }] } : { rows: [] })],
    ]));
    const res = await resolve({ phone: "+1 (403) 555-0177" });
    expect(res.body).toEqual({ ok: true, matched: true, isStaff: true, name: "Kim Doe", userId: "u-7" });
    const statements = queryMock.mock.calls.map((c) => String(c[0]));
    const contactsAt = statements.findIndex((s) => s.includes("FROM contacts c"));
    const fallbackAt = statements.map((s, i) => (STAFF_DIRECTORY.test(s) ? i : -1)).filter((i) => i >= 0)[1];
    expect(contactsAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(contactsAt);
    const [, fallback] = callsMatching(queryMock, STAFF_DIRECTORY);
    expect(String(fallback[0])).toContain("coalesce(phone_number, phone, '')");
    expect(fallback[1]).toEqual(["4035550177"]);
  });

  it("identifies internal callers without changing client calls", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM contacts c/, { rows: [{ contact_id: "c-1", name: "Jo Client", company: "Jo Co" }] }]]));
    const client = await resolve({ phone: "+14035550178" });
    expect(client.body).toMatchObject({ matched: true, isStaff: false, name: "Jo Client", contactId: "c-1" });

    queryMock.mockImplementation(answerBySql([[STAFF_DIRECTORY, { rows: [{ user_id: "u-8", first_name: "Sam", last_name: "Staff" }] }]]));
    const staff = await resolve({ phone: "+14035550179" });
    expect(staff.body).toMatchObject({ matched: true, isStaff: true, name: "Sam Staff" });
  });
});
