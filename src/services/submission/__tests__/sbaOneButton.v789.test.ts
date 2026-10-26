// BF_SERVER_SBA_ONE_BUTTON_v789
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

const h = vi.hoisted(() => ({
  envelopes: 0,
  start: vi.fn(),
  notifyAdmins: vi.fn(async () => {}),
  remind: vi.fn(async () => ({ name: "Todd", phone: "+15875550100", smsSent: true, resent: true, throttled: false, lastSentAt: null })),
  describe: vi.fn(async () => ({ name: "Todd", phone: "+15875550100", smsSent: true, resent: false, throttled: false, lastSentAt: "2026-10-08T22:00:00Z" })),
  claimed: false,
  signed: null as string | null,
  isSba: true,
  formsComplete: true,
  restart: vi.fn(async () => []),
  embedded: vi.fn(async () => ({ status: "ready" })),
  query: vi.fn(),
}));

vi.mock("../../../signnow/sba/sbaTrigger.js", () => ({
  isSbaApplication: vi.fn(async () => h.isSba),
  sbaEnvelopeCount: vi.fn(async () => h.envelopes),
  sbaFormsComplete: vi.fn(async () => ({ complete: h.formsComplete, missing: h.formsComplete ? [] : ["sba_form_413"] })),
  startSbaSigningForStaff: h.start,
  restartSbaSigning: h.restart,
}));
vi.mock("../../../signnow/embeddedSigningSession.js", () => ({ getOrCreateEmbeddedSigningSession: h.embedded }));
// The staff routes below read the same database as the orchestrator does.
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../../../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: vi.fn(async () => ({ stillNeeded: [], rejected: [], required: [] })) }));
vi.mock("../../../signnow/ownerSigningNotice.js", () => ({ remindOwner1ToSign: h.remind, describeOwner1Notice: h.describe }));
vi.mock("../../notifications/notifyAdminsForCreditSummary.js", () => ({ notifyAdminsForCreditSummary: h.notifyAdmins }));

import { maybeStartCreditSummaryAndSign } from "../orchestrator.js";

h.query.mockImplementation(async (sql: string) => {
  if (/SELECT silo FROM applications/.test(sql)) return { rows: [{ silo: "BF" }] };
  if (/FROM application_tasks/.test(sql)) return { rows: [{ open_count: "0" }] };
  if (/MAX\(finalized_at\)/.test(sql)) return { rows: [{ finalized_at: "2026-10-08T00:00:00Z" }] };
  if (/SELECT credit_summary_completed_at/.test(sql)) return { rows: [{ credit_summary_completed_at: null, signnow_app_signed_at: h.signed, requested_amount: 1000000 }] };
  if (/AS accord/.test(sql)) return { rows: [{ accord: false }] };
  if (/AS complete/.test(sql)) return { rows: [{ complete: false }] };
  if (/SET submission_chain_started_at = NOW\(\)/.test(sql)) { if (h.claimed) return { rows: [] }; h.claimed = true; return { rows: [{ id: "a1" }] }; }
  if (/SET submission_chain_started_at = NULL/.test(sql)) { h.claimed = false; return { rows: [] }; }
  return { rows: [] };
});
const pool: any = { query: h.query };
const ctx = { pool, applicationId: "a1" };

describe("Send on the Lenders tab starts SBA signing", () => {
  beforeEach(() => {
    h.envelopes = 0; h.claimed = false; h.signed = null; h.isSba = true; h.formsComplete = true;
    h.start.mockReset(); h.restart.mockClear(); h.embedded.mockClear(); h.notifyAdmins.mockClear(); h.remind.mockClear(); h.describe.mockClear();
  });
  it("starts the one SBA signing and reports who was texted", async () => {
    h.start.mockResolvedValue({ started: true, owners: [{ ownerIndex: 1, name: "Todd", email: "t@x.com", started: true, delivery: "client portal" }] });
    const r = await maybeStartCreditSummaryAndSign(ctx);
    expect(h.start).toHaveBeenCalledWith("a1");
    expect(r.fired).toBe(true);
    expect(r.notice?.phone).toBe("+15875550100");
  });
  it("never sends the staff credit-summary alert for an SBA file", async () => {
    h.start.mockResolvedValue({ started: true, owners: [] });
    await maybeStartCreditSummaryAndSign(ctx);
    expect(h.notifyAdmins).not.toHaveBeenCalled();
  });
  it("Send again while unsigned re-texts owner 1 instead of making new envelopes", async () => {
    h.envelopes = 2;
    const r = await maybeStartCreditSummaryAndSign(ctx);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.remind).toHaveBeenCalled();
    expect(r.reason).toBe("already_started");
  });
  it("says the SBA forms are unfinished and releases the claim so a later Send can retry", async () => {
    h.start.mockResolvedValue({ started: false, reason: "sba_forms_incomplete", missing: ["sba_form_413"] });
    const r = await maybeStartCreditSummaryAndSign(ctx);
    expect(r).toEqual({ fired: false, reason: "sba_forms_incomplete" });
    expect(h.claimed).toBe(false);
  });
  it("does nothing once the file is signed", async () => {
    h.signed = "2026-10-08T00:00:00Z";
    const r = await maybeStartCreditSummaryAndSign(ctx);
    expect(r.reason).toBe("already_signed");
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe("the other entry points use the same start", () => {
  const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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
    h.envelopes = 0; h.claimed = false; h.signed = null; h.isSba = true; h.formsComplete = true;
    h.start.mockReset(); h.restart.mockClear(); h.embedded.mockClear();
    h.start.mockResolvedValue({ started: true, owners: [{ ownerIndex: 1, name: "Todd", email: "t@x.com", started: true, delivery: "client portal" }] });
  });

  it("Send for signing on the Application tab starts SBA signing on an SBA file", async () => {
    const app = await mount("/api/applications", "../../../modules/applications/applications.routes.js");
    const res = await request(app).post(`/api/applications/${APP_ID}/resend-signing`).set("Authorization", `Bearer ${token()}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, sessionStatus: "ready" });
    expect(h.start).toHaveBeenCalledWith(APP_ID);
    expect(h.embedded).not.toHaveBeenCalled();
  });

  it("a non-SBA file still gets the ordinary signing session", async () => {
    h.isSba = false;
    const app = await mount("/api/applications", "../../../modules/applications/applications.routes.js");
    await request(app).post(`/api/applications/${APP_ID}/resend-signing`).set("Authorization", `Bearer ${token()}`).send({});
    expect(h.start).not.toHaveBeenCalled();
    expect(h.embedded).toHaveBeenCalledWith(APP_ID, { skipOwner1Notice: true }); // BF_SERVER_v857_SIGNING_NOTIFY
  });

  it("readiness reports SBA forms unfinished / signing already out", async () => {
    const app = await mount("/api/applications", "../../../modules/applications/applications.routes.js");
    const read = async () => (await request(app).get(`/api/applications/${APP_ID}/signing-readiness`).set("Authorization", `Bearer ${token()}`)).body.data.reason;
    expect(await read()).toBe("ready");
    h.formsComplete = false;
    expect(await read()).toBe("sba_forms_incomplete");
    h.envelopes = 1;
    expect(await read()).toBe("started");
  });

  it("the signing badge sees SBA envelopes", async () => {
    const base = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/FROM applications a WHERE a\.id::text/.test(sql)) return { rows: [{ id: APP_ID, silo: "BF", metadata: { sba_signnow: [{ ownerIndex: 1, groupId: "grp-sba" }] }, finalized_lenders: 0, signnow_app_signed_at: null }] };
      return base(sql, params);
    });
    try {
      const app = await mount("/api/applications", "../../../modules/applications/applications.routes.js");
      const res = await request(app).get(`/api/applications/${APP_ID}/details`).set("Authorization", `Bearer ${token()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.signing.status).toBe("started");
    } finally {
      h.query.mockImplementation(base);
    }
  });

  it("the old SBA-only resend no longer drops the application from the signing", async () => {
    const app = await mount("/api/portal", "../../../routes/applicationFormResponses.js");
    const res = await request(app).post(`/api/portal/applications/${APP_ID}/sba-signing/resend`).set("Authorization", `Bearer ${token()}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(h.start).toHaveBeenCalledWith(APP_ID);
    expect(h.restart).not.toHaveBeenCalled();
  });
});
