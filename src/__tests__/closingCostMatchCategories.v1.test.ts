import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { APP_ID, PARAM_GUARD_RULE, buildV1App } from "./helpers/v1AppsHarness.js";

// BF_SERVER_CLOSING_COST_MATCH_CATEGORIES_v1 - guards that the step-2 closing-cost
// companion writes metadata.match_categories (the array the lender-match engine reads),
// not just closing_cost_routing.
// BF_SERVER_CLOSING_COST_LOC_OVER_50K_v1 - the routing is now binary: under $50k
// TERM, $50k and over LOC. It is never both.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));

async function createCompanion(parentAmount: number) {
  queryMock.mockReset();
  queryMock.mockImplementation(
    answerBySql([PARAM_GUARD_RULE, [/select requested_amount from applications where id = \$1/, { rows: [{ requested_amount: parentAmount }] }]]),
  );
  const res = await request(await buildV1App())
    .post("/api/client/applications")
    .send({ kind: "closing_costs", parent_application_id: APP_ID, requested_amount: null });
  expect(res.status).toBe(201);
  const insert = callsMatching(queryMock, /insert into applications/);
  expect(insert).toHaveLength(1);
  return insert[0]![1] as unknown[];
}

describe("step-2 closing-cost companion match categories", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
  });

  it("sets match_categories from the routing decision: $50k and over is LOC only", async () => {
    const params = await createCompanion(400_000);
    const metadata = params[3] as Record<string, unknown>;
    expect(metadata.match_categories).toEqual(["LOC"]);
    expect(params[9]).toBe(60_000);
  });

  it("under $50k is TERM only", async () => {
    const metadata = (await createCompanion(100_000))[3] as Record<string, unknown>;
    expect(metadata.match_categories).toEqual(["TERM"]);
  });

  it("keeps the routing string alongside the array", async () => {
    expect(((await createCompanion(400_000))[3] as Record<string, unknown>).closing_cost_routing).toBe("loc");
    expect(((await createCompanion(100_000))[3] as Record<string, unknown>).closing_cost_routing).toBe("term");
  });
});
