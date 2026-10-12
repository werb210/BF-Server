import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { APP_ID, buildV1App, submitBaseRules } from "./helpers/v1AppsHarness.js";

// BF_SERVER_CLOSING_COST_COMPANION_NAME_v1 - guards that the submit handler propagates the
// promoted business name onto closing-cost companion children still named with a
// placeholder ("Untitled Application" / draft), so the add-on stops showing "Untitled".
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: vi.fn(async () => undefined) }));

const PROPAGATE = /SET name = \$2, updated_at = NOW\(\)\s+WHERE parent_application_id/;

async function submit(app: Record<string, unknown>) {
  return request(await buildV1App()).post(`/api/client/applications/${APP_ID}/submit`).send({ app });
}

describe("closing-cost companion name propagation", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql(submitBaseRules()));
  });

  it("updates companion children on submit with the promoted business name", async () => {
    const res = await submit({ business: { companyName: "Bismillah Grocers" } });
    expect(res.status).toBe(200);
    const calls = callsMatching(queryMock, PROPAGATE);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual([APP_ID, "Bismillah Grocers"]);
    const sql = String(calls[0]![0]);
    // Only closing-cost companions of this parent are touched.
    expect(sql).toContain("COALESCE((metadata->>'closing_cost_companion')::boolean, false) = true");
  });

  it("only overwrites placeholder names", async () => {
    await submit({ business: { companyName: "Acme" } });
    const sql = String(callsMatching(queryMock, PROPAGATE)[0]![0]);
    expect(sql).toContain("name = 'Untitled Application'");
    expect(sql).toContain("name ILIKE 'draft%'");
    expect(sql).toContain("name = 'Draft application'");
    expect(sql).toMatch(/name IS NULL OR name = ''/);
  });

  it("does nothing when the submit carries no business name", async () => {
    const res = await submit({ kyc: { fundingAmount: "$10,000" } });
    expect(res.status).toBe(200);
    expect(callsMatching(queryMock, PROPAGATE)).toHaveLength(0);
  });

  it("a failed propagation does not fail the submit", async () => {
    queryMock.mockImplementation(answerBySql([[PROPAGATE, new Error("db down")], ...submitBaseRules()]));
    const res = await submit({ business: { companyName: "Acme" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, mode: "legacy" });
  });
});
