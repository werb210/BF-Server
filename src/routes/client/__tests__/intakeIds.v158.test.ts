// BF_SERVER_INTAKE_IDS_v158
// Found by running the real server against a real Postgres and posting an SBA
// application: lender_product_id came back NULL with no error.
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";
import { APP_ID, PARAM_GUARD_RULE, buildV1App, submitBaseRules } from "../../../__tests__/helpers/v1AppsHarness.js";

const { queryMock, logInfo } = vi.hoisted(() => ({ queryMock: vi.fn(), logInfo: vi.fn() }));
vi.mock("../../../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../../../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: vi.fn(async () => undefined) }));
vi.mock("../../../observability/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../observability/logger.js")>()),
  logInfo,
}));

// Real shape from a hand-created product. Postgres takes it; RFC-4122 (version/variant nibbles) does not.
const PG_ONLY_ID = "a1b2c3d4-1111-2222-3333-444455556666";
const SUBMIT_UPDATE = /requested_amount = COALESCE\(\$2, requested_amount\)/;

async function create(body: Record<string, unknown>) {
  const res = await request(await buildV1App()).post("/api/client/applications").send(body);
  expect(res.status).toBe(201);
  return callsMatching(queryMock, /insert into applications/)[0]![1] as unknown[];
}
async function submit(body: Record<string, unknown>) {
  return request(await buildV1App()).post(`/api/client/applications/${APP_ID}/submit`).send(body);
}

describe("the product link matches what the column accepts", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    logInfo.mockReset();
    queryMock.mockImplementation(answerBySql(submitBaseRules()));
  });

  it("accepts an id Postgres would store but RFC-4122 rejects (selected product id and lender id)", async () => {
    const params = await create({ selected_product: { id: PG_ONLY_ID, lender_id: PG_ONLY_ID } });
    expect(params[7]).toBe(PG_ONLY_ID); // lender_id
    expect(params[8]).toBe(PG_ONLY_ID); // lender_product_id
    expect(logInfo).not.toHaveBeenCalledWith("intake_product_id_not_linkable", expect.anything());
  });

  it("accepts it as a top-level lender_product_id on submit", async () => {
    const res = await submit({ app: { lender_product_id: PG_ONLY_ID } });
    expect(res.status).toBe(200);
    const params = callsMatching(queryMock, SUBMIT_UPDATE)[0]![1] as unknown[];
    expect(params[3]).toBe(PG_ONLY_ID);
  });

  it("still rejects something that is not a uuid at all", async () => {
    const params = await create({ selected_product: { id: "sba-prod-1", lender_id: "" } });
    expect(params[7]).toBeNull();
    expect(params[8]).toBeNull();
  });

  it("reports a product that can never link instead of dropping it", async () => {
    await create({ selected_product: { id: "sba-prod-1" } });
    expect(logInfo).toHaveBeenCalledWith(
      "intake_product_id_not_linkable",
      expect.objectContaining({
        offeredProductId: "sba-prod-1",
        detail: expect.stringContaining("lender_products.id is TEXT but applications"),
      }),
    );
  });
});

describe("a submit that records nothing does not report success", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    logInfo.mockReset();
    queryMock.mockImplementation(answerBySql(submitBaseRules()));
  });

  it("rejects an empty payload and says what to send", async () => {
    const res = await submit({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("submit_payload_required");
    expect(res.body.error.detail).toContain("Send { app } or { normalized }");
    expect(callsMatching(queryMock, SUBMIT_UPDATE)).toHaveLength(0);
  });

  it("rejects an app that is not an object", async () => {
    const res = await submit({ app: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("submit_payload_required");
  });

  it("still accepts a legacy submit that has an app", async () => {
    const res = await submit({ app: { business: { companyName: "Acme" } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, applicationId: APP_ID, mode: "legacy" });
  });

  it("logs it, because a truncated submit otherwise looks identical to a good one", async () => {
    await submit({});
    expect(logInfo).toHaveBeenCalledWith("client_submit_empty_payload", { applicationId: APP_ID });
  });
});

describe("the route is still mounted with its param guard", () => {
  it("an unknown token is a 404", async () => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([PARAM_GUARD_RULE]));
    const res = await submit({ app: {} });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("application_not_found");
  });
});
