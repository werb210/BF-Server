// BF_SERVER_CLIENT_LENDER_RESPONSES_v4
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { APP_ID, CLIENT_PHONE, PARAM_GUARD_RULE, buildV1App, clientToken } from "./helpers/v1AppsHarness.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));

const OWNS = /FROM applications a\s+JOIN contacts c/;
const RESPONSES = /FROM application_lender_responses/;
const url = `/api/client/application/${APP_ID}/lender-responses`;

describe("client lender responses v4", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
  });

  it("checks ownership before reading outcomes", async () => {
    // A token proves who the caller is, not which application they may read.
    queryMock.mockImplementation(
      answerBySql([
        PARAM_GUARD_RULE,
        [OWNS, { rows: [] }],
        [RESPONSES, { rows: [{ ordinal: 1, outcome: "declined", reason: "x", created_at: "2026-01-01" }] }],
      ]),
    );
    const res = await request(await buildV1App()).get(url).set("Authorization", `Bearer ${clientToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Application not found.");
    const owns = callsMatching(queryMock, OWNS);
    expect(owns).toHaveLength(1);
    expect(owns[0]![1]).toEqual([APP_ID, CLIENT_PHONE.replace(/\D/g, "").slice(-10)]);
    expect(callsMatching(queryMock, RESPONSES)).toHaveLength(0);
  });

  it("refuses a caller with no token and one with no phone claim", async () => {
    queryMock.mockImplementation(answerBySql([PARAM_GUARD_RULE]));
    const app = await buildV1App();
    expect((await request(app).get(url)).status).toBe(401);
    const noPhone = clientToken("");
    expect((await request(app).get(url).set("Authorization", `Bearer ${noPhone}`)).status).toBe(401);
    expect(callsMatching(queryMock, RESPONSES)).toHaveLength(0);
  });

  it("returns the owner's outcomes in order and never the lender identity", async () => {
    const row = { ordinal: 1, outcome: "approved", reason: null, created_at: "2026-01-01" };
    queryMock.mockImplementation(
      answerBySql([PARAM_GUARD_RULE, [OWNS, { rows: [{ "?column?": 1 }] }], [RESPONSES, { rows: [row] }]]),
    );
    const res = await request(await buildV1App()).get(url).set("Authorization", `Bearer ${clientToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", data: { responses: [row] } });
    const read = callsMatching(queryMock, RESPONSES);
    expect(read).toHaveLength(1);
    const sql = String(read[0]![0]);
    expect(sql).toContain("SELECT ordinal, outcome, reason, created_at");
    expect(sql).not.toContain("lender_id");
    expect(sql).toContain("ORDER BY ordinal ASC");
    expect(read[0]![1]).toEqual([APP_ID]);
  });
});
