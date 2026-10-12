// BF_SERVER_RCS_BRAND_BF_ONLY_v781 / BF_SERVER_SBA_NOTICE_APP_FIRST_v781 / BF_SERVER_SBA_READINESS_v781
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { smsSenderFor } from "../lib/smsFrom.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendSMS: vi.fn(async () => ({ sid: "SM1" })),
  twilioCreate: vi.fn(async () => ({ sid: "SM2", status: "queued" })),
  order: [] as string[],
  pushToClientApp: vi.fn(async () => false),
  sendSms: vi.fn(async () => ({})),
  snapshot: { allDocsAccepted: true, allTasksComplete: true, lenderSelectionsFinalized: true, applicationSigned: false, collateralRequired: false, collateralComplete: false } as Record<string, boolean>,
  isSba: true,
  envelopes: 0,
  formsComplete: true,
}));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: h.queryMock }, runQuery: h.queryMock, dbQuery: h.queryMock, query: h.queryMock };
});
vi.mock("../services/smsService.js", () => ({ sendSMS: h.sendSMS }));
vi.mock("../lib/sharedClients.js", () => ({ sharedTwilio: () => ({ messages: { create: h.twilioCreate } }) }));
vi.mock("../services/notifications/notifyClient.js", () => ({
  pushToClientApp: async (...a: unknown[]) => { h.order.push("app"); return (h.pushToClientApp as any)(...a); },
  notifyClient: vi.fn(async () => ({ channel: "sms" })),
}));
vi.mock("../modules/notifications/sms.service.js", () => ({ sendSms: async (...a: unknown[]) => { h.order.push("sms"); return (h.sendSms as any)(...a); } }));
vi.mock("../services/clientEmail.js", () => ({ resolveClientEmail: vi.fn(async () => ({ email: null, firstName: null })), crmContactEmail: vi.fn(async () => null) }));
vi.mock("../signnow/sba/sbaSigning.js", () => ({
  createSbaSigningSessions: vi.fn(async () => [{ ownerIndex: 1, name: "Jane Roe", email: "jane@example.com", url: "https://signnow.example/1" }]),
}));
vi.mock("../signnow/sba/sbaOwners.js", async (orig) => ({
  ...(await orig<typeof import("../signnow/sba/sbaOwners.js")>()),
  resolveSbaOwners: vi.fn(async () => [{ index: 1, fullName: "Jane Roe", email: "jane@example.com", phone: "+15875550142" }]),
}));
// The readiness route's SBA lookups are steered per test; the rest of sbaTrigger stays real.
vi.mock("../signnow/sba/sbaTrigger.js", async (orig) => ({
  ...(await orig<typeof import("../signnow/sba/sbaTrigger.js")>()),
  isSbaApplication: vi.fn(async () => h.isSba),
  sbaEnvelopeCount: vi.fn(async () => h.envelopes),
  sbaFormsComplete: vi.fn(async () => ({ complete: h.formsComplete, missing: h.formsComplete ? [] : ["sba_form_413"] })),
}));
vi.mock("../services/submission/orchestrator.js", () => ({ readReadinessSnapshot: vi.fn(async () => ({ ...h.snapshot })) }));

const MG = "MG" + "0123456789abcdef0123456789abcdef";
const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const adminToken = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000a1", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

afterEach(() => { delete process.env.TWILIO_RCS_MESSAGING_SERVICE_SID; });
beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([]));
  h.sendSMS.mockClear(); h.twilioCreate.mockClear(); h.sendSms.mockClear(); h.pushToClientApp.mockReset();
  h.order.length = 0;
  h.snapshot = { allDocsAccepted: true, allTasksComplete: true, lenderSelectionsFinalized: true, applicationSigned: false, collateralRequired: false, collateralComplete: false };
  h.isSba = true; h.envelopes = 0; h.formsComplete = true;
});

async function mount(path: string, modPath: string) {
  const router = (await import(modPath)).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use(path, router);
  app.use(errorHandler);
  return app;
}

describe("the Boreal Financial RCS brand is used for Boreal Financial only", () => {
  it("Financial texts use the RCS Messaging Service once it is set", () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = MG;
    expect(smsSenderFor("+17805550100", "+18254511768")).toEqual({ messagingServiceSid: MG });
    expect(smsSenderFor("+17805550100", "+18254511768", { silo: "BF" })).toEqual({ messagingServiceSid: MG });
  });
  it("Insurance texts stay plain SMS from the normal number", () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = MG;
    expect(smsSenderFor("+17805550100", "+18254511768", { silo: "BI" })).toEqual({ from: "+18254511768" });
    expect(smsSenderFor("+17805550100", "+18254511768", { silo: "bi" })).toEqual({ from: "+18254511768" });
  });

  it("BI-Server's text bridge sends as the Insurance silo", async () => {
    process.env.BACKEND_SERVICE_TOKEN = "svc-token-v781";
    const app = await mount("/api/service", "../routes/serviceBridge.js");
    const res = await request(app).post("/api/service/sms").set("X-Backend-Token", "svc-token-v781").send({ to: "+17805550100", body: "Your policy renews soon" });
    expect(res.status).toBe(200);
    expect(h.sendSMS).toHaveBeenCalledWith("+17805550100", "Your policy renews soon", { silo: "BI" });
  });

  it("staff texts in the Insurance silo pass their silo (plain SMS); Financial texts use RCS", async () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = MG;
    const app = await mount("/api/communications", "../routes/communications.js");
    const bi = await request(app).post("/api/communications/sms").set("Authorization", `Bearer ${adminToken()}`).set("X-Silo", "BI").send({ to: "+17804561234", body: "Hello from Insurance" });
    expect(bi.status).toBeLessThan(300);
    const biArgs = (h.twilioCreate.mock.calls[0] as unknown as [any])[0];
    expect(biArgs.messagingServiceSid).toBeUndefined();
    expect(biArgs.from).toBeTruthy();

    const bf = await request(app).post("/api/communications/sms").set("Authorization", `Bearer ${adminToken()}`).set("X-Silo", "BF").send({ to: "+17804561234", body: "Hello from Financial" });
    expect(bf.status).toBeLessThan(300);
    const bfArgs = (h.twilioCreate.mock.calls[1] as unknown as [any])[0];
    expect(bfArgs.messagingServiceSid).toBe(MG);
  });
});

describe("SBA ready-to-sign notice and banner", () => {
  function sbaAnswers() {
    return answerBySql([
      [/FROM lender_submissions s/, { rows: [{ n: "1" }] }],
      [/SELECT doc_type, owner_fingerprint FROM application_form_responses/, { rows: [{ doc_type: "sba_form_1919", owner_fingerprint: null }, { doc_type: "sba_form_413", owner_fingerprint: null }] }],
    ]);
  }

  it("tries the Boreal app before texting owner 1", async () => {
    h.queryMock.mockImplementation(sbaAnswers());
    h.pushToClientApp.mockResolvedValue(false);
    const { sendSbaForSigning } = await vi.importActual<typeof import("../signnow/sba/sbaTrigger.js")>("../signnow/sba/sbaTrigger.js");
    const out = await sendSbaForSigning(APP_ID);
    expect(out.ok).toBe(true);
    expect(h.order).toEqual(["app", "sms"]);
    expect((h.sendSms.mock.calls[0] as unknown as [any])[0]).toMatchObject({ to: "+15875550142" });
    expect(String((h.sendSms.mock.calls[0] as unknown as [any])[0].message)).toContain("ready to sign. Sign in at");
    expect(out.notice?.sms).toBe(true);
  });

  it("does not text owner 1 when the app took the notice", async () => {
    h.queryMock.mockImplementation(sbaAnswers());
    h.pushToClientApp.mockResolvedValue(true);
    const { sendSbaForSigning } = await vi.importActual<typeof import("../signnow/sba/sbaTrigger.js")>("../signnow/sba/sbaTrigger.js");
    const out = await sendSbaForSigning(APP_ID);
    expect(h.order).toEqual(["app"]);
    expect(h.sendSms).not.toHaveBeenCalled();
    expect(out.notice?.sms).toBe(false);
  });

  // BF_SERVER_SBA_ONE_BUTTON_v789 - superseded: an SBA file now saves its lender first (the 4506-C names it) and
  // signs from the same Send as every other file, so "no lender finalized" is the right message again.
  describe("SBA files get their own readiness states on top of the normal ones", () => {
    const readiness = async () => {
      const app = await mount("/api/applications", "../modules/applications/applications.routes.js");
      const res = await request(app).get(`/api/applications/${APP_ID}/signing-readiness`).set("Authorization", `Bearer ${adminToken()}`);
      expect(res.status).toBe(200);
      return res.body.data;
    };

    it("lender not finalized is reported as such, not as an SBA-only state", async () => {
      h.snapshot.lenderSelectionsFinalized = false;
      const d = await readiness();
      expect(d.reason).toBe("lender_not_finalized");
      expect(d.canSend).toBe(false);
    });

    it("unfinished SBA forms", async () => {
      h.formsComplete = false;
      const d = await readiness();
      expect(d.reason).toBe("sba_forms_incomplete");
    });

    it("signing already out", async () => {
      h.envelopes = 2;
      expect((await readiness()).reason).toBe("started");
    });

    it("an SBA file with forms done and nothing out is ready", async () => {
      const d = await readiness();
      expect(d.reason).toBe("ready");
      expect(d.canSend).toBe(true);
    });
  });
});
