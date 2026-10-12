// BF_SERVER_BLOCK_v84_COMPANION_ROUTING_BY_AMOUNT_v1
// BF_SERVER_CLOSING_COST_LOC_OVER_50K_v1 - this file used to declare its own
// copy of the companion formula and assert against that copy, so it passed no
// matter what the route actually did (it was asserting 20% while the submit-time
// normalizer already used 15%). It now drives the real routes: the Step 2 create,
// the submit-time fallback companion, and the submit-time normalizer.
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";
import { APP_ID, PARAM_GUARD_RULE, buildV1App, submitBaseRules } from "../../../__tests__/helpers/v1AppsHarness.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../../../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: vi.fn(async () => undefined) }));

async function stepTwoCompanion(parentAmount: number) {
  queryMock.mockReset();
  queryMock.mockImplementation(
    answerBySql([PARAM_GUARD_RULE, [/select requested_amount from applications where id = \$1/, { rows: [{ requested_amount: parentAmount }] }]]),
  );
  const res = await request(await buildV1App())
    .post("/api/client/applications")
    .send({ linked_application_reason: "closing_costs", parent_application_id: APP_ID });
  expect(res.status).toBe(201);
  const params = callsMatching(queryMock, /insert into applications/)[0]![1] as unknown[];
  return { amount: params[9], metadata: params[3] as Record<string, any>, source: params[10] };
}

async function submitFallbackCompanion(equipmentAmount: number) {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql(submitBaseRules()));
  const res = await request(await buildV1App())
    .post(`/api/client/applications/${APP_ID}/submit`)
    .send({ app: { productCategory: "Equipment", requires_closing_cost_funding: true, equipment_amount: equipmentAmount, business: { companyName: "Acme" } } });
  expect(res.status).toBe(200);
  const insert = callsMatching(queryMock, /'closing_costs_companion',/);
  expect(insert).toHaveLength(1);
  const params = insert[0]![1] as unknown[];
  return { amount: params[5], category: params[6], metadata: JSON.parse(String(params[9])) };
}

describe("closing-cost companion routing", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
  });

  it("uses 15% of the parent amount at Step 2, never 20%", async () => {
    const c = await stepTwoCompanion(200_000);
    expect(c.amount).toBe(30_000);
    expect(c.source).toBe("closing_costs_companion");
  });

  it("uses 15% of the equipment amount in the submit fallback", async () => {
    const c = await submitFallbackCompanion(200_000);
    expect(c.amount).toBe(30_000);
  });

  it("the submit-time normalizer computes 15%, capped at $250k", async () => {
    queryMock.mockImplementation(answerBySql(submitBaseRules()));
    await request(await buildV1App())
      .post(`/api/client/applications/${APP_ID}/submit`)
      .send({ app: { business: { companyName: "Acme" } } });
    const norm = callsMatching(queryMock, /WITH parent AS/);
    expect(norm).toHaveLength(1);
    expect(norm[0]![1]).toEqual([APP_ID]);
    const sql = String(norm[0]![0]);
    expect(sql).toContain("LEAST(ROUND(amt * 0.15), 250000)");
    expect(sql).not.toMatch(/amt \* 0\.2\b/);
  });

  it("caps the Step 2 companion at $250k", async () => {
    expect((await stepTwoCompanion(2_000_000)).amount).toBe(250_000);
  });

  it("routes under $50k to TERM and $50k+ to LOC, never both", async () => {
    const term = await stepTwoCompanion(300_000); // 45,000
    expect(term.metadata.closing_cost_routing).toBe("term");
    expect(term.metadata.match_categories).toEqual(["TERM"]);
    const loc = await stepTwoCompanion(400_000); // 60,000
    expect(loc.metadata.closing_cost_routing).toBe("loc");
    expect(loc.metadata.match_categories).toEqual(["LOC"]);

    const fbTerm = await submitFallbackCompanion(300_000);
    expect(fbTerm.category).toBe("TERM");
    expect(fbTerm.metadata.match_categories).toEqual(["TERM"]);
    const fbLoc = await submitFallbackCompanion(400_000);
    expect(fbLoc.category).toBe("LOC");
    expect(fbLoc.metadata.match_categories).toEqual(["LOC"]);
  });

  it("$50k exactly is LOC", async () => {
    const c = await stepTwoCompanion(333_334); // 50,000
    expect(c.amount).toBe(50_000);
    expect(c.metadata.match_categories).toEqual(["LOC"]);
  });

  it("sets product_category to match the routing decision", async () => {
    expect((await stepTwoCompanion(300_000)).metadata.product_category).toBe("Term Loan");
    expect((await stepTwoCompanion(400_000)).metadata.product_category).toBe("LOC");
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql(submitBaseRules()));
    await request(await buildV1App()).post(`/api/client/applications/${APP_ID}/submit`).send({ app: { business: { companyName: "Acme" } } });
    const sql = String(callsMatching(queryMock, /WITH parent AS/)[0]![0]);
    expect(sql).toMatch(/product_category = CASE WHEN \(SELECT cc FROM calc\) >= 50000\s+THEN 'LOC' ELSE 'TERM' END/);
    expect(sql).toContain(`THEN '["LOC"]'::jsonb ELSE '["TERM"]'::jsonb END`);
  });
});
