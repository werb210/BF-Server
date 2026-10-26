// BF_SERVER_v858_PARTNER_SIGNING - a partner who signs in to the client portal with their own phone finds the
// application they are a partner on (it was matched on the applicant's phone only, so Elizabeth Cullen landed on an
// empty new application). Each row says whether the caller is the applicant or a partner on it.
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { APP_ID, PARAM_GUARD_RULE, buildV1App, clientToken } from "./helpers/v1AppsHarness.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
  dbQuery: queryMock,
}));

describe("v858 the client's application list includes files they are a partner on", () => {
  it("matches the applicant's phone OR a partner contact's phone, and says which", async () => {
    vi.resetModules();
    queryMock.mockReset();
    const row = { id: APP_ID, pipeline_state: "Off to Lender", business_name: "Poke Prod LLC", signature_needed: true, viewer_role: "partner" };
    queryMock.mockImplementation(answerBySql([PARAM_GUARD_RULE, [/AS signature_needed/, { rows: [row] }]]));
    const res = await request(await buildV1App()).get("/api/client/applications/by-phone").set("Authorization", `Bearer ${clientToken("+14035550177")}`);
    expect(res.status).toBe(200);
    expect(res.body.applications[0]).toMatchObject({ id: APP_ID, viewer_role: "partner" });
    const [call] = callsMatching(queryMock, /AS signature_needed/);
    const sql = String(call![0]);
    expect(call![1]).toEqual(["4035550177"]);
    expect(sql).toMatch(/LEFT JOIN contacts c ON c\.id = COALESCE\(a\.contact_id/);
    expect(sql).toMatch(/OR EXISTS \(SELECT 1 FROM application_contacts v858ac[\s\S]+v858ac\.role = 'partner'[\s\S]+= \$1\)/);
    expect(sql).toMatch(/THEN 'applicant' ELSE 'partner' END AS viewer_role/);
  });
});
