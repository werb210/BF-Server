// BF_SERVER_CRM_MIRROR_NORMALIZED_FALLBACKS_v1 + BF_SERVER_EMAIL_AUTOCREATE_CONTACT_v1
// 1) Submit's CRM mirror must resolve business/applicant from every payload
//    shape (thin legacy body -> normalized fallbacks) and log when it skips.
// 2) Inbox emails to unknown external recipients must auto-create a lead
//    contact and log the email to it.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { APP_ID, buildV1App, submitBaseRules } from "./helpers/v1AppsHarness.js";
import { bearer } from "./helpers/staffToken.js";

const { queryMock, mirrorMock, graphFetch } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mirrorMock: vi.fn(async () => undefined),
  graphFetch: vi.fn(async () => new Response("", { status: 202 })),
}));
vi.mock("../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: vi.fn(async () => ({ fetch: graphFetch })) }));
vi.mock("../services/biOutreach.js", () => ({ bumpBiOutreachToContacted: vi.fn(async () => undefined) }));

async function mirrorInputFor(body: Record<string, unknown>) {
  vi.doMock("../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: mirrorMock }));
  queryMock.mockImplementation(answerBySql(submitBaseRules()));
  await request(await buildV1App()).post(`/api/client/applications/${APP_ID}/submit`).send(body);
  expect(mirrorMock).toHaveBeenCalledTimes(1);
  return (mirrorMock.mock.calls[0] as unknown[])[0] as Record<string, any>;
}

describe("CRM record creation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/applicationCrmMirror.js");
    queryMock.mockReset();
    mirrorMock.mockClear();
    graphFetch.mockClear();
  });
  // BF_SERVER_v861_TEST_SETTLE - submit starts background CRM work (people sync) after it answers. Let it finish before
  // the next test, so its queries never land on the next test's freshly reset mock (the v859 PR run failed this way).
  afterEach(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 20));
  });

  it("mirror call maps normalized + alternate keys", async () => {
    // Thin legacy body: business and applicant only exist on `normalized`.
    const thin = await mirrorInputFor({
      app: { kyc: {} },
      normalized: { company: { name: "Bismillah Grocers" }, applicants: [{ firstName: "Ann", email: "ann@bg.test", mobile: "+15875550100" }] },
    });
    expect(thin.business).toMatchObject({ companyName: "Bismillah Grocers" });
    expect(thin.applicant).toMatchObject({ firstName: "Ann", email: "ann@bg.test", phone: "+15875550100" });

    mirrorMock.mockClear();
    const legal = await mirrorInputFor({ app: { business_info: { legalName: "BG Holdings Ltd", state: "AB" }, borrower: { name: "Ann Lee" } } });
    expect(legal.business).toMatchObject({ companyName: "BG Holdings Ltd", province: "AB" });
    expect(legal.applicant).toMatchObject({ fullName: "Ann Lee" });

    mirrorMock.mockClear();
    const none = await mirrorInputFor({ app: { kyc: {} } });
    expect(none.business).toBeNull();
    expect(none.applicant).toBeNull();
  });

  it("mirror logs instead of silently skipping", async () => {
    queryMock.mockImplementation(answerBySql([]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { mirrorApplicationToCrm } = await import("../services/applicationCrmMirror.js");
      await mirrorApplicationToCrm({ applicationId: APP_ID, silo: "BF", business: null, applicant: null });
      expect(warn).toHaveBeenCalledWith("[crm_mirror] skipped - no business/applicant data", { applicationId: APP_ID });
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("inbox send auto-creates lead contacts for unknown external recipients", async () => {
    queryMock.mockImplementation(
      answerBySql([
        [/SELECT id, lower\(email\) AS email, lower\(secondary_email\) AS secondary_email FROM contacts/, { rows: [{ id: "known-1", email: "known@acme.test", secondary_email: null }] }],
        [/INSERT INTO contacts/, (_sql: string, params?: unknown[]) => ({ rows: [{ id: `new-${String(params?.[1])}` }] })],
      ]),
    );
    const app = express();
    app.use(express.json());
    app.use("/api/o365", (await import("../routes/o365.js")).default);
    const res = await request(app)
      .post("/api/o365/mail/send")
      .set("Authorization", bearer("Staff"))
      .send({ to: ["jane.doe99@newco.test", "known@acme.test"], cc: ["todd@boreal.financial", "ops@boreal.insure"], subject: "Hi", body_html: "<p>x</p>" });
    expect(res.status).toBe(200);
    const created = callsMatching(queryMock, /INSERT INTO contacts/);
    expect(created).toHaveLength(1);
    expect(created[0]![1]).toEqual(["Jane Doe", "jane.doe99@newco.test", "BF"]);
    expect(String(created[0]![0])).toContain("ARRAY['email']::text[]");
    expect(String(created[0]![0])).toContain("'lead'");
    const logged = callsMatching(queryMock, /INSERT INTO crm_email_log/).map((c) => (c[1] as unknown[])[7]);
    expect(logged.sort()).toEqual(["known-1", "new-jane.doe99@newco.test"]);
  });
});

// BF_SERVER_LEG_CRM_PROPAGATION_v1
describe("leg CRM propagation", () => {
  it("mirror propagates the fresh contact/company link to companion legs", async () => {
    vi.resetModules();
    vi.doUnmock("../services/applicationCrmMirror.js");
    queryMock.mockReset();
    queryMock.mockImplementation(
      answerBySql([
        [/INSERT INTO companies/, { rows: [{ id: "co-1" }] }],
        [/INSERT INTO contacts/, { rows: [{ id: "ct-1" }] }],
        [/information_schema\.columns/, { rows: [{ exists: true }] }],
      ]),
    );
    const { mirrorApplicationToCrm } = await import("../services/applicationCrmMirror.js");
    await mirrorApplicationToCrm({ applicationId: APP_ID, silo: "BF", business: { companyName: "Acme" }, applicant: { email: "ann@acme.test" } });
    const legs = callsMatching(queryMock, /WHERE parent_application_id = \$1/);
    expect(legs).toHaveLength(1);
    expect(legs[0]![1]).toEqual([APP_ID, "co-1", "ct-1"]);
    expect(String(legs[0]![0])).toContain("AND (contact_id IS NULL OR company_id IS NULL)");
  });
});
