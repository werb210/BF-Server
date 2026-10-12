// BF_SERVER_PIPELINE_PLACEHOLDER_NAME_v1 + BF_SERVER_SUBMIT_NAME_FALLBACKS_v1
// A submitted application must never keep/render the 'Draft application'
// placeholder: submit resolves the business name from every payload shape,
// and the board SQL treats placeholders as absent.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { APP_ID, buildV1App, submitBaseRules } from "./helpers/v1AppsHarness.js";
import { bearer } from "./helpers/staffToken.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));
vi.mock("../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: vi.fn(async () => undefined) }));
vi.mock("../startupState.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../startupState.js")>()),
  isReady: () => true,
}));

const SUBMIT_UPDATE = /requested_amount = COALESCE\(\$2, requested_amount\)/;

async function promotedName(body: Record<string, unknown>): Promise<{ name: unknown; sql: string }> {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql(submitBaseRules()));
  await request(await buildV1App()).post(`/api/client/applications/${APP_ID}/submit`).send(body);
  const call = callsMatching(queryMock, SUBMIT_UPDATE)[0]!;
  return { name: (call[1] as unknown[])[5], sql: String(call[0]) };
}

describe("placeholder application names", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("submit falls back to business_info and normalized.company.name", async () => {
    expect((await promotedName({ app: { business_info: { companyName: "Bismillah Grocers" } } })).name).toBe("Bismillah Grocers");
    expect((await promotedName({ app: { business_info: { legalName: "BG Ltd" } } })).name).toBe("BG Ltd");
    expect((await promotedName({ app: { kyc: {} }, normalized: { company: { name: "From Normalized" } } })).name).toBe("From Normalized");
    expect((await promotedName({ app: { business: { companyName: "Primary" }, business_info: { companyName: "Ignored" } } })).name).toBe("Primary");
    expect((await promotedName({ app: { kyc: {} } })).name).toBeNull();
  });

  it("the promoted name only replaces an empty or placeholder name", async () => {
    const { sql } = await promotedName({ app: { business_info: { companyName: "Acme" } } });
    expect(sql).toMatch(/WHEN \(name IS NULL OR name = '' OR name ILIKE 'draft%' OR name = 'Draft application'\)\s+THEN COALESCE\(\$6, name\)/);
  });

  it("pipeline board nulls out placeholder names", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([[/AS business_name/, { rows: [{ id: APP_ID, business_name: "Acme Co", stage: "Received" }] }]]));
    const app = express();
    app.use("/api/portal", (await import("../routes/portal.js")).default);
    const res = await request(app).get("/api/portal/applications").set("Authorization", bearer("Staff"));
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ name: "Acme Co", businessName: "Acme Co" });
    const sql = String(callsMatching(queryMock, /AS business_name/)[0]![0]);
    expect(sql).toMatch(/COALESCE\(\s*NULLIF\(NULLIF\(NULLIF\(a\.name, ''\), 'Draft application'\), 'Untitled Application'\),\s*c\.name, 'Unnamed application'\) AS business_name/);
  });
});
