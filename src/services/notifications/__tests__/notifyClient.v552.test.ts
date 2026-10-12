// BF_SERVER_BLOCK_v552_NOTIFY_CLIENT
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql } from "../../../__tests__/helpers/answerBySql.js";
import { notifyClient, type NotifyDeps } from "../notifyClient.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendSMS: vi.fn(async () => ({ sid: "SM1" })),
}));
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return {
    ...actual,
    pool: { query: h.queryMock, connect: vi.fn(async () => ({ query: h.queryMock, release: vi.fn() })) },
    runQuery: h.queryMock, dbQuery: h.queryMock, query: h.queryMock,
  };
});
// The routes' notices go through notifyClient; the real implementation still answers the unit tests below.
vi.mock("../notifyClient.js", async (orig) => {
  const real = await orig<typeof import("../notifyClient.js")>();
  const { vi: v } = await import("vitest");
  const spy = v.fn((n: any, d?: any) => (d ? real.notifyClient(n, d) : Promise.resolve({ channel: "push" as const })));
  return { ...real, notifyClient: spy };
});
vi.mock("../../smsService.js", () => ({ sendSMS: h.sendSMS }));
vi.mock("../../../lib/storage/index.js", () => ({
  getStorage: () => ({ put: vi.fn(async () => ({ blobName: "ts/blob.pdf", url: "https://blob/ts.pdf", sizeBytes: 4 })) }),
}));

const notice = { phone: "+1 (403) 555-0199", applicationId: "a1", kind: "term_sheet", sms: "SMS text", title: "T", body: "B" };
const deps = (over: Partial<NotifyDeps> = {}): NotifyDeps => ({
  pushReady: vi.fn(async () => true),
  pushUsersForPhone: vi.fn(async () => ["client:+14035550199"]),
  push: vi.fn(async () => 1),
  sms: vi.fn(async () => undefined),
  record: vi.fn(async () => undefined),
  ...over,
});

describe("v552 app first, SMS otherwise", () => {
  it("app installed: push, no SMS", async () => {
    const d = deps();
    expect(await notifyClient(notice, d)).toEqual({ channel: "push" });
    expect(d.pushUsersForPhone).toHaveBeenCalledWith("4035550199");
    expect(d.sms).not.toHaveBeenCalled();
  });
  it("no app on this phone: SMS", async () => {
    const d = deps({ pushUsersForPhone: vi.fn(async () => []) });
    expect(await notifyClient(notice, d)).toEqual({ channel: "sms" });
    expect(d.sms).toHaveBeenCalledWith(notice.phone, "SMS text", { kind: "term_sheet", applicationId: "a1" }); // v555 tracking
  });
  it("push not configured yet: SMS without looking for devices", async () => {
    const d = deps({ pushReady: vi.fn(async () => false) });
    expect((await notifyClient(notice, d)).channel).toBe("sms");
    expect(d.pushUsersForPhone).not.toHaveBeenCalled();
  });
  it("every device refused (uninstalled app): falls back to SMS", async () => {
    const d = deps({ push: vi.fn(async () => 0) });
    expect((await notifyClient(notice, d)).channel).toBe("sms");
  });
  it("a push error still falls back to SMS", async () => {
    const d = deps({ push: vi.fn(async () => { throw new Error("apns down"); }) });
    expect((await notifyClient(notice, d)).channel).toBe("sms");
  });
  it("SMS failure is reported, never thrown, and recorded", async () => {
    const d = deps({ pushUsersForPhone: vi.fn(async () => []), sms: vi.fn(async () => { throw new Error("twilio 400"); }) });
    const r = await notifyClient(notice, d);
    expect(r.channel).toBe("none");
    expect(r.error).toContain("twilio");
    expect(d.record).toHaveBeenCalledWith(notice, "4035550199", r);
  });
  it("no usable phone: nothing sent", async () => {
    const d = deps();
    expect(await notifyClient({ ...notice, phone: "12" }, d)).toEqual({ channel: "none", error: "no_phone" });
    expect(d.sms).not.toHaveBeenCalled();
  });
});

describe("the client notices use it (no second push, no second SMS)", () => {
  const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const LENDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const PHONE = "+15875550142";
  const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
  let spy: any;

  async function mount(path: string, modPath: string) {
    const router = (await import(modPath)).default;
    const { errorHandler } = await import("../../../middleware/errors.js");
    const app = express();
    app.use(express.json());
    app.use(path, router);
    app.use(errorHandler);
    return app;
  }
  const kinds = () => spy.mock.calls.map((c: any[]) => c[0].kind);

  beforeEach(async () => {
    spy = (await import("../notifyClient.js")).notifyClient;
    spy.mockClear();
    h.sendSMS.mockClear();
    h.queryMock.mockReset();
    h.queryMock.mockImplementation(answerBySql([
      [/SELECT id FROM applications WHERE id::text/, { rows: [{ id: APP_ID }] }],
      [/SELECT silo, pipeline_state FROM applications/, { rows: [{ silo: "BF", pipeline_state: "Off to Lender" }] }],
      [/FROM lender_products lp JOIN lenders l/, { rows: [{ lender_id: LENDER_ID, name: "Acme Capital" }] }],
      [/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }],
      [/SELECT id, silo, owner_user_id\s+FROM applications/, { rows: [{ id: APP_ID, silo: "BF", owner_user_id: null }] }],
      [/c\.phone/, { rows: [{ phone: PHONE }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM qa_questions/, { rows: [{ n: 2 }] }],
    ]));
  });

  it("additional steps: one notice", async () => {
    const app = await mount("/api/applications", "../../../modules/applications/applications.routes.js");
    const res = await request(app).post(`/api/applications/${APP_ID}/request-steps`).set("Authorization", `Bearer ${token()}`).send({ forms: ["networth"], documents: ["Void cheque"] });
    expect(res.status).toBe(200);
    expect(kinds()).toEqual(["additional_steps"]);
    expect(h.sendSMS).not.toHaveBeenCalled();
  });

  it("term sheet from the Lenders tab: one notice", async () => {
    const app = await mount("/api/applications", "../../../modules/applications/applications.routes.js");
    const res = await request(app).post(`/api/applications/${APP_ID}/lenders/${LENDER_ID}/files`).set("Authorization", `Bearer ${token()}`)
      .attach("file", Buffer.from("%PDF"), { filename: "terms.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(kinds()).toEqual(["term_sheet"]);
    expect(spy.mock.calls[0][0]).toMatchObject({ phone: PHONE, applicationId: APP_ID });
    expect(h.sendSMS).not.toHaveBeenCalled();
  });

  it("term sheet from the portal: one notice, no direct SMS", async () => {
    const app = await mount("/api/portal", "../../../routes/portal.js");
    const res = await request(app).post(`/api/portal/applications/${APP_ID}/term-sheet`).set("Authorization", `Bearer ${token()}`)
      .field("lender_name", "Acme Capital").attach("file", Buffer.from("%PDF"), { filename: "terms.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(kinds()).toEqual(["term_sheet"]);
    expect(String(spy.mock.calls[0][0].sms)).toContain("Your term sheet from Acme Capital");
    expect(h.sendSMS).not.toHaveBeenCalled();
  });

  it("documents deferred at submit: documents_remaining", async () => {
    const app = await mount("/api/client", "../../../routes/client/v1Applications.js");
    const res = await request(app).post(`/api/client/applications/${APP_ID}/submit`).send({ app: { documentsDeferred: true } });
    expect(res.status).toBe(200);
    expect(kinds()).toContain("documents_remaining");
    expect(h.sendSMS).not.toHaveBeenCalled();
  });

  it("lender questions sent to the client: lender_questions", async () => {
    const app = await mount("/api/portal", "../../../routes/lenderQa.js");
    const res = await request(app).post(`/api/portal/applications/${APP_ID}/qa/sets/set-1/submit`).set("Authorization", `Bearer ${token()}`).send({});
    expect(res.status).toBe(200);
    expect(kinds()).toEqual(["lender_questions"]);
    expect(h.sendSMS).not.toHaveBeenCalled();
  });
});
