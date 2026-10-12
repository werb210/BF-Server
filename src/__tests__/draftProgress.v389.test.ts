// BF_SERVER_DRAFT_PROGRESS_v389
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applicantIdentity, fillDraftContact, furthestStep } from "../services/draftProgress.js";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { APP_ID, PARAM_GUARD_RULE, buildV1App } from "./helpers/v1AppsHarness.js";
import { bearer } from "./helpers/staffToken.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));

const FILL_NAME = /UPDATE contacts c\s+SET first_name = NULLIF\(\$2, ''\)/;
const FILL_EMAIL = /UPDATE contacts c\s+SET email = \$2/;
const FURTHEST = "GREATEST(NULLIF(metadata->>'furthestStep','')::int, NULLIF(metadata->>'currentStep','')::int)";

describe("furthest step", () => {
  it("never goes down when the applicant steps back", () => {
    expect(furthestStep({ currentStep: 4 }, { currentStep: 2 })).toBe(4);
    expect(furthestStep({ furthestStep: 5, currentStep: 3 }, { currentStep: 3 })).toBe(5);
    expect(furthestStep({}, { currentStep: 2 })).toBe(2);
  });
  it("ignores junk", () => {
    expect(furthestStep({ currentStep: "x" }, { currentStep: 99 })).toBe(0);
  });
});

describe("applicant identity from Step 4", () => {
  it("reads first/last/email and tidies them", () => {
    expect(applicantIdentity({ firstName: " Ann ", lastName: "Smith", email: "ANN@acme.com " })).toEqual({ first: "Ann", last: "Smith", email: "ann@acme.com" });
  });
  it("falls back to fullName and drops a bad email", () => {
    expect(applicantIdentity({ fullName: "Mary Ann Lee", email: "nope" })).toEqual({ first: "Mary", last: "Ann Lee", email: "" });
  });
  it("returns null when nothing was typed", () => {
    expect(applicantIdentity({})).toBeNull();
    expect(applicantIdentity(null)).toBeNull();
  });
});

describe("wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
  });

  async function patch(existing: Record<string, unknown>, body: Record<string, unknown>) {
    queryMock.mockImplementation(
      answerBySql([PARAM_GUARD_RULE, [/select id, name, pipeline_state/, { rows: [{ id: APP_ID, name: "Draft application", metadata: existing }] }]]),
    );
    const res = await request(await buildV1App()).patch(`/api/client/applications/${APP_ID}`).send(body);
    expect(res.status).toBe(200);
    const update = callsMatching(queryMock, /update applications\s+set name = \$2/);
    expect(update).toHaveLength(1);
    return (update[0]![1] as unknown[])[3] as Record<string, unknown>;
  }

  it("the draft save records the furthest step, even when the applicant steps back", async () => {
    expect((await patch({ currentStep: 5 }, { currentStep: 3 })).furthestStep).toBe(5);
    queryMock.mockReset();
    expect((await patch({}, { currentStep: 2 })).furthestStep).toBe(2);
  });

  it("the draft save fills the contact from the Step 4 applicant", async () => {
    await patch({}, { currentStep: 4, applicant: { firstName: "Ann", lastName: "Smith", email: "ANN@acme.com" } });
    const name = callsMatching(queryMock, FILL_NAME);
    expect(name).toHaveLength(1);
    expect(name[0]![1]).toEqual([APP_ID, "Ann", "Smith", "Unknown", "(application started)"]);
    expect(callsMatching(queryMock, FILL_EMAIL)[0]![1]).toEqual([APP_ID, "ann@acme.com"]);
  });

  it("only the OTP placeholder name is replaced, and only a blank email filled", async () => {
    await fillDraftContact(APP_ID, { firstName: "Ann", lastName: "Smith", email: "ann@acme.com" });
    const nameSql = String(callsMatching(queryMock, FILL_NAME)[0]![0]);
    expect(nameSql).toContain("(NULLIF(btrim(c.first_name), '') IS NULL OR c.first_name = $4)");
    expect(nameSql).toContain("(NULLIF(btrim(c.last_name), '') IS NULL OR c.last_name = $5)");
    expect(String(callsMatching(queryMock, FILL_EMAIL)[0]![0])).toContain("AND NULLIF(btrim(c.email), '') IS NULL");
  });

  it("a failed contact fill never fails the draft save", async () => {
    queryMock.mockImplementation(answerBySql([[FILL_NAME, new Error("duplicate key")]]));
    await expect(fillDraftContact(APP_ID, { firstName: "Ann" })).resolves.toBeUndefined();
  });

  it("marketing and dashboard funnels read the furthest step", async () => {
    queryMock.mockImplementation(answerBySql([], { rows: [] }));
    const app = express();
    app.use(express.json());
    app.use("/api/dashboard", (await import("../routes/dashboard.js")).default);
    app.use("/api/marketing", (await import("../routes/marketing.js")).default);
    const auth = bearer("Admin");
    expect((await request(app).get("/api/dashboard/funnel").set("Authorization", auth)).status).toBe(200);
    expect((await request(app).get("/api/marketing/funnel").set("Authorization", auth)).status).toBe(200);
    expect((await request(app).get("/api/marketing/abandoned").set("Authorization", auth)).status).toBe(200);
    const dash = callsMatching(queryMock, /WITH stepped AS/);
    expect(dash).toHaveLength(1);
    expect(String(dash[0]![0]).split(FURTHEST).length - 1).toBe(2);
    const mkFunnel = callsMatching(queryMock, /WITH a AS \(/);
    expect(String(mkFunnel[0]![0])).toContain(FURTHEST);
    const abandoned = callsMatching(queryMock, /AND a\.submitted_at IS NULL/);
    expect(String(abandoned[0]![0])).toContain("GREATEST(NULLIF(a.metadata->>'furthestStep','')::int, NULLIF(a.metadata->>'currentStep','')::int)");
  });
});
