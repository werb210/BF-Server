// BF_SERVER_RECENT_CALLS_DISPOSITION_v203
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { STAFF_USER_ID, mountRouter, staffToken } from "../../__tests__/helpers/staffRouterApp.js";
import { callRefPredicate, parseCallRef } from "../../modules/calls/callRef.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));

const CALL_ID = "c4115000-0000-4000-8000-000000000203";

async function recentCalls() {
  const app = mountRouter((await import("../voiceCalls.js")).default, "/api/voice");
  const res = await request(app).get("/api/voice/recent-calls").set("Authorization", `Bearer ${staffToken()}`);
  const [call] = callsMatching(queryMock, /FROM call_logs cl/);
  return { res, sql: String(call?.[0] ?? ""), params: call?.[1] };
}

beforeEach(() => {
  queryMock.mockReset().mockImplementation(answerBySql([
    [/FROM call_logs cl/, { rows: [{ id: CALL_ID, direction: "inbound", status: "completed", duration_seconds: 30, created_at: "2026-09-01T10:00:00Z", phone_number: "+14035550100", contact_id: null, contact_name: "Ann", disposition: "voicemail" }] }],
  ]));
});

describe("recent calls feed", () => {
  it("returns the disposition so an outcome already set is visible", async () => {
    const { res, sql } = await recentCalls();
    expect(res.body.items[0].disposition).toBe("voicemail");
    expect(sql).toContain("cl.disposition,");
    expect(sql).toMatch(/SELECT id, direction, status, duration_seconds, created_at, phone_number, contact_id, contact_name, disposition/);
  });

  it("returns cl.id, which is the reference the disposition endpoint matches", async () => {
    const { res, sql, params } = await recentCalls();
    expect(sql).toContain("cl.id::text AS id");
    expect(params).toEqual([STAFF_USER_ID]);
    const ref = parseCallRef(res.body.items[0].id);
    expect(ref).toEqual({ kind: "id", value: CALL_ID });
    expect(callRefPredicate(ref!)).toBe("id = $2::uuid");
  });

  it("reads call_logs directly, so no conferences join is involved", async () => {
    // conferences has no link to call_logs; that mismatch is why the contact
    // call feed cannot host this control.
    const { sql } = await recentCalls();
    expect(sql).toContain("FROM call_logs cl");
    expect(sql).not.toContain("conferences");
  });
});
