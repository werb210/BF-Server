// BF_SERVER_SBA_OWNER_IDENTITY_v104
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";
import { ownerFingerprint } from "../sbaOwners.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  owners: [] as Array<Record<string, unknown>>,
  ownersError: null as Error | null,
}));
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: h.queryMock }, runQuery: h.queryMock, dbQuery: h.queryMock, query: h.queryMock };
});
vi.mock("../sbaOwners.js", async (orig) => ({
  ...(await orig<typeof import("../sbaOwners.js")>()),
  resolveSbaOwners: vi.fn(async () => { if (h.ownersError) throw h.ownersError; return h.owners; }),
}));
vi.mock("../../../routes/clientDocumentsNeeded.js", async (orig) => ({
  ...(await orig<typeof import("../../../routes/clientDocumentsNeeded.js")>()),
  computeOutstandingDocs: vi.fn(async () => ({ stillNeeded: [{ document_type: "x", label: "x" }], rejected: [], required: [] })),
}));

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JANE = { index: 1, fullName: "Jane Roe", email: "jane@example.com" };
const JOHN = { index: 2, fullName: "John Doe", email: "john@example.com" };
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function mount(path: string, modPath: string) {
  const router = (await import(modPath)).default;
  const { errorHandler } = await import("../../../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use(path, router);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([]));
  h.owners = [JANE, JOHN];
  h.ownersError = null;
});

describe("ownerFingerprint", () => {
  it("is stable across position", () => {
    const a = ownerFingerprint({ fullName: "Jane Roe", email: "jane@example.com" });
    const b = ownerFingerprint({ fullName: "Jane Roe", email: "jane@example.com" });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("distinguishes two different owners", () => {
    expect(ownerFingerprint({ email: "jane@example.com" }))
      .not.toBe(ownerFingerprint({ email: "john@example.com" }));
  });

  it("ignores case and stray whitespace", () => {
    expect(ownerFingerprint({ email: "  Jane@Example.com " }))
      .toBe(ownerFingerprint({ email: "jane@example.com" }));
  });

  it("falls back to name when there is no email", () => {
    expect(ownerFingerprint({ fullName: "Jane  Roe" }))
      .toBe(ownerFingerprint({ fullName: "jane roe" }));
  });

  it("returns empty for an owner with neither", () => {
    expect(ownerFingerprint({})).toBe("");
  });
});

describe("stale responses", () => {
  const complete = async (rows: Array<{ doc_type: string; owner_fingerprint: string | null }>) => {
    h.queryMock.mockImplementation(answerBySql([[/SELECT doc_type, owner_fingerprint FROM application_form_responses/, { rows }]]));
    const { sbaFormsComplete } = await import("../sbaTrigger.js");
    return sbaFormsComplete(APP_ID);
  };

  it("a 413 whose owner changed does not count as submitted", async () => {
    const out = await complete([
      { doc_type: "sba_form_1919", owner_fingerprint: null },
      { doc_type: "sba_form_413", owner_fingerprint: ownerFingerprint(JANE) },
      // Filled for someone else who used to hold position 2.
      { doc_type: "sba_form_413_owner_2", owner_fingerprint: ownerFingerprint({ email: "former@example.com" }) },
    ]);
    expect(out).toEqual({ complete: false, missing: ["sba_form_413_owner_2"] });
  });

  it("an unstamped legacy response is still accepted", async () => {
    const out = await complete([
      { doc_type: "sba_form_1919", owner_fingerprint: null },
      { doc_type: "sba_form_413", owner_fingerprint: null },
      { doc_type: "sba_form_413_owner_2", owner_fingerprint: null },
    ]);
    expect(out).toEqual({ complete: true, missing: [] });
  });
});

describe("submit-time stamping", () => {
  const submit = async (docType: string) => {
    h.queryMock.mockClear();
    h.queryMock.mockImplementation(answerBySql([[/INSERT INTO application_form_responses/, { rows: [{ id: "r1", doc_type: docType, data: {} }], rowCount: 1 }]]));
    const app = await mount("/api/portal", "../../../routes/applicationFormResponses.js");
    return request(app).post(`/api/portal/applications/${APP_ID}/form-responses/${docType}/submit`).set("Authorization", `Bearer ${token()}`).send({ data: { total: 1 } });
  };
  const stamps = () => callsMatching(h.queryMock, /SET owner_fingerprint = \$3/).map((c) => c[1]);
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { warn.mockRestore(); });

  it("stamps only the per-owner 413s", async () => {
    expect((await submit("sba_form_413_owner_2")).status).toBe(200);
    expect(stamps()).toEqual([[APP_ID, "sba_form_413_owner_2", ownerFingerprint(JOHN)]]);
    expect((await submit("sba_form_413")).status).toBe(200);
    expect(stamps()).toEqual([[APP_ID, "sba_form_413", ownerFingerprint(JANE)]]);
    expect((await submit("sba_form_1919")).status).toBe(200);
    expect(stamps()).toEqual([]);
  });

  it("never blocks a submission on stamping", async () => {
    h.ownersError = new Error("owners unavailable");
    const res = await submit("sba_form_413_owner_2");
    expect(res.status).toBe(200);
    expect(stamps()).toEqual([]);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes("[sba_owner_fingerprint] failed"))).toBe(true);
  });
});

describe("staff checklist", () => {
  const taskStatus = async (prompts: string[], submitted: string[]) => {
    h.queryMock.mockImplementation(answerBySql([
      [/SELECT DISTINCT cta_action, max\(cta_label\)/, { rows: prompts.map((cta_action) => ({ cta_action, cta_label: null })) }],
      [/SELECT doc_type FROM application_form_responses/, { rows: submitted.map((doc_type) => ({ doc_type })) }],
    ]));
    const app = await mount("/api/applications", "../../../modules/applications/applications.routes.js");
    const res = await request(app).get(`/api/applications/${APP_ID}/task-status`).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    return Object.fromEntries((res.body.tasks as any[]).map((t) => [t.key, t]));
  };

  it("maps the SBA doc types", async () => {
    const t = await taskStatus(["form:sba1919", "form:sba413"], ["sba_form_1919", "sba_form_413_owner_2"]);
    expect(t.sba1919.complete).toBe(true);
    expect(t.sba413.complete).toBe(true);
  });

  it("short-circuits ahead of the loose substring tests", async () => {
    // An SBA doc type that happens to contain "debt" / "cra" must not tick those tasks.
    const t = await taskStatus(["debt", "cra"], ["sba_form_debt_schedule", "sba_form_cra_consent"]);
    expect(t.debt.complete).toBe(false);
    expect(t.cra.complete).toBe(false);
  });

  it("labels both forms for staff", async () => {
    const t = await taskStatus(["form:sba1919", "form:sba413"], []);
    expect(t.sba1919.label).toBe("SBA Form 1919");
    expect(t.sba413.label).toBe("SBA Form 413");
  });
});
