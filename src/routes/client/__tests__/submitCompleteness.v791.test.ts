// BF_SERVER_v791_SUBMIT_COMPLETENESS - the applicant submit re-checks the wizard's
// Step 1/3/4 required answers (BF-client wizard/stepValidation.ts) server-side.
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";
import { APP_ID, buildV1App, submitBaseRules } from "../../../__tests__/helpers/v1AppsHarness.js";
import { checkSubmitCompleteness } from "../../../services/applicationCompleteness.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../../../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: vi.fn(async () => undefined) }));

const SUBMIT_UPDATE = /requested_amount = COALESCE\(\$2, requested_amount\)/;
const STORED_METADATA = /SELECT metadata FROM applications WHERE id::text/;

function standardApp(): Record<string, any> {
  return {
    kyc: {
      lookingFor: "WORKING_CAPITAL",
      fundingAmount: "$250,000",
      businessLocation: "Canada",
      industry: "Construction",
      purposeOfFunds: "Working Capital",
      monthlyRevenue: "$50,000 to $100,000",
    },
    productCategory: "TERM",
    selectedProductType: "TERM",
    business: {
      businessName: "Acme Fabrication",
      businessStructure: "Corporation",
      address: "1 Main St",
      city: "Calgary",
      state: "AB",
      zip: "T2P 1A1",
      phone: "(403) 555-1234",
      startDate: "2015-01-01",
      employees: "12",
      estimatedRevenue: "$1,000,000",
    },
    applicant: {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@acme.example",
      phone: "4035550100",
      street: "2 Elm St",
      city: "Calgary",
      state: "AB",
      zip: "T2P 1A2",
      dob: "1980-01-01",
      ssn: "123456789",
      ownership: "100",
    },
  };
}

describe("checkSubmitCompleteness (port of the wizard rules)", () => {
  it("a complete standard application passes", () => {
    expect(checkSubmitCompleteness(standardApp(), null)).toEqual({ ok: true, checked: true });
  });

  it("missing SIN on the standard path fails Step 4", () => {
    const app = standardApp();
    app.applicant.ssn = "";
    expect(checkSubmitCompleteness(app, null)).toEqual({ ok: false, step: 4, missing: ["SIN / SSN"] });
  });

  it("media path: no industry, monthly revenue, employees or yearly revenue needed", () => {
    const app = standardApp();
    app.kyc.purposeOfFunds = "Media Financing";
    app.kyc.industry = "";
    app.kyc.monthlyRevenue = "";
    app.productCategory = "MEDIA";
    app.selectedProductType = "MEDIA";
    app.business.employees = "";
    app.business.estimatedRevenue = "";
    expect(checkSubmitCompleteness(app, null)).toEqual({ ok: true, checked: true });
  });

  it("SBA path: Step 3 asks nothing", () => {
    const app = standardApp();
    app.productCategory = "SBA_GOVERNMENT";
    app.selectedProductType = "SBA_GOVERNMENT";
    app.kyc.businessLocation = "United States";
    app.kyc.monthlyRevenue = "";
    app.business = { businessName: "" };
    expect(checkSubmitCompleteness(app, null)).toEqual({ ok: true, checked: true });
  });

  it("US start-up path: no industry, no monthly revenue", () => {
    const app = standardApp();
    app.kyc.businessLocation = "United States";
    app.kyc.purposeOfFunds = "Start up Funding";
    app.kyc.industry = "";
    app.kyc.monthlyRevenue = "";
    expect(checkSubmitCompleteness(app, null)).toEqual({ ok: true, checked: true });
  });

  it("Canada: blank or below-floor monthly revenue fails Step 1; the US does not ask", () => {
    const ca = standardApp();
    ca.kyc.monthlyRevenue = "Under $10,000";
    expect(checkSubmitCompleteness(ca, null)).toEqual({ ok: false, step: 1, missing: ["your average monthly revenue"] });
    const us = standardApp();
    us.kyc.businessLocation = "United States";
    us.kyc.monthlyRevenue = "";
    expect(checkSubmitCompleteness(us, null)).toEqual({ ok: true, checked: true });
  });

  it("partner fields only when ownership is 1-99, and ownership must total 100", () => {
    const app = standardApp();
    app.applicant.ownership = "60";
    const r = checkSubmitCompleteness(app, null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.step).toBe(4);
      expect(r.missing).toContain("partner SIN / SSN");
      expect(r.missing).toContain("ownership adding up to 100% across every owner");
    }
    app.applicant.partner = { ...standardApp().applicant, firstName: "Sam", ownership: "40" };
    expect(checkSubmitCompleteness(app, null)).toEqual({ ok: true, checked: true });
    app.applicant.partner.ownership = "30";
    expect(checkSubmitCompleteness(app, null)).toEqual({ ok: false, step: 4, missing: ["ownership adding up to 100% across every owner"] });
  });

  it("an answer already stored on the application fills a blank in the payload", () => {
    const app = standardApp();
    app.applicant.ssn = "";
    expect(checkSubmitCompleteness(app, { applicant: { ssn: "123456789" } })).toEqual({ ok: true, checked: true });
    expect(checkSubmitCompleteness(app, { formData: { applicant: { ssn: "123456789" } } })).toEqual({ ok: true, checked: true });
  });

  it("an unrecognised shape is not checked", () => {
    expect(checkSubmitCompleteness({ lender_product_id: "x" }, null)).toMatchObject({ ok: true, checked: false });
    expect(checkSubmitCompleteness(undefined, null)).toMatchObject({ ok: true, checked: false });
    expect(checkSubmitCompleteness({ business: { companyName: "Acme" } }, null)).toMatchObject({ ok: true, checked: false, absent: ["kyc", "applicant"] });
  });
});

describe("POST /api/client/applications/:token/submit completeness gate", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql(submitBaseRules()));
  });

  async function submit(body: Record<string, unknown>) {
    return request(await buildV1App()).post(`/api/client/applications/${APP_ID}/submit`).send(body);
  }

  it("a complete standard application is submitted", async () => {
    const res = await submit({ app: standardApp() });
    expect(res.status).toBe(200);
    expect(callsMatching(queryMock, SUBMIT_UPDATE)).toHaveLength(1);
  });

  it("missing SIN returns 422 step 4 before anything is written", async () => {
    const app = standardApp();
    delete app.applicant.ssn;
    const res = await submit({ app });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "application_incomplete", step: 4, missing: ["SIN / SSN"] });
    expect(callsMatching(queryMock, SUBMIT_UPDATE)).toHaveLength(0);
    expect(callsMatching(queryMock, /^\s*(UPDATE|INSERT)/i)).toHaveLength(0);
  });

  it("uses what is already stored on the application", async () => {
    queryMock.mockImplementation(answerBySql([
      [STORED_METADATA, { rows: [{ metadata: { applicant: { ssn: "123456789" } } }] }],
      ...submitBaseRules(),
    ]));
    const app = standardApp();
    app.applicant.ssn = "";
    const res = await submit({ app });
    expect(res.status).toBe(200);
  });

  it("an unrecognised (older) payload shape is allowed with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await submit({ app: { lender_product_id: "a1b2c3d4-1111-2222-3333-444455556666" } });
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("unrecognised payload shape"))).toBe(true);
    warn.mockRestore();
  });
});
