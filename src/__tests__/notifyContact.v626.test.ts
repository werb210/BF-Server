// BF_SERVER_NOTIFY_CONTACT_v626
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";

const state = vi.hoisted(() => ({ contact: null as any, inserts: [] as any[], pushOk: false, smsSent: [] as any[], biCalls: [] as any[] }));

vi.mock("../db.js", async () => ({
  ...(await vi.importActual<any>("../db.js")),
  pool: {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.includes("FROM contacts")) return { rows: state.contact ? [state.contact] : [] };
      if (sql.includes("FROM applications")) return { rows: [{ id: "app-1" }] };
      if (sql.includes("INSERT INTO crm_timeline_events")) { state.inserts.push(params); return { rows: [] }; }
      return { rows: [] };
    }),
  },
}));
vi.mock("../services/notifications/notifyClient.js", () => ({ pushToClientApp: vi.fn(async () => state.pushOk) }));
vi.mock("../modules/notifications/sms.service.js", () => ({ sendSms: vi.fn(async (m: any) => { state.smsSent.push(m); }) }));
vi.mock("../services/biApplicantMessages.js", () => ({ notifyBiApplicant: vi.fn(async (m: any) => { state.biCalls.push(m); return { ok: true }; }) }));

import { cleanNotice, notifyContact } from "../services/notifications/notifyContact.js";

beforeEach(() => { state.contact = null; state.inserts = []; state.pushOk = false; state.smsSent = []; state.biCalls = []; });

describe("cleanNotice", () => {
  it("needs a message and defaults the title", () => {
    expect(cleanNotice("", "")).toBeNull();
    expect(cleanNotice("", "Please upload your ID")).toEqual({ title: "Update on your application", body: "Please upload your ID" });
  });
});

describe("notifyContact", () => {
  it("uses the app when it can be reached, and logs it on the timeline", async () => {
    state.contact = { id: "c1", phone: "+17805550100", silo: "BF" };
    state.pushOk = true;
    const r = await notifyContact({ contactId: "c1", title: "Hi", body: "Docs needed" });
    expect(r).toEqual({ ok: true, channel: "app" });
    expect(state.smsSent).toHaveLength(0);
    expect(JSON.parse(state.inserts[0][1]).channel).toBe("app");
  });
  it("falls back to SMS with the portal link", async () => {
    state.contact = { id: "c1", phone: "+17805550100", silo: "BF" };
    const r = await notifyContact({ contactId: "c1", title: "Hi", body: "Docs needed" });
    expect(r.channel).toBe("sms");
    expect(state.smsSent[0].message).toContain("/application/app-1");
  });
  it("sends Boreal Risk contacts through BI-Server", async () => {
    state.contact = { id: "c2", phone: "+17805550100", silo: "BI" };
    const r = await notifyContact({ contactId: "c2", title: "Hi", body: "Docs needed" });
    expect(r.channel).toBe("bi");
    expect(state.biCalls[0].contactId).toBe("c2");
  });
  it("reports a missing phone and unknown contact", async () => {
    state.contact = { id: "c3", phone: null, silo: "BF" };
    expect((await notifyContact({ contactId: "c3", title: "t", body: "b" })).error).toBe("no_phone");
    state.contact = null;
    expect((await notifyContact({ contactId: "zz", title: "t", body: "b" })).error).toBe("contact_not_found");
  });
});

describe("wiring", () => {
  const crmApp = async () => mountRouter((await import("../routes/crm.js")).default, "/api/crm");

  it("the CRM route sends the notice", async () => {
    state.contact = { id: "c1", phone: "+17805550100", silo: "BF" };
    state.pushOk = true;
    const res = await request(await crmApp()).post("/api/crm/contacts/c1/notify")
      .set("Authorization", `Bearer ${staffToken()}`).send({ title: "Hi", body: "Docs needed" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, channel: "app" });
    expect(JSON.parse(state.inserts[0][1])).toMatchObject({ channel: "app", title: "Hi", body: "Docs needed" });
  });

  it("the CRM route refuses an empty notice and 404s an unknown contact", async () => {
    const app = await crmApp();
    const auth = { Authorization: `Bearer ${staffToken()}` };
    expect((await request(app).post("/api/crm/contacts/c1/notify").set(auth).send({ title: "", body: "" })).status).toBe(400);
    expect((await request(app).post("/api/crm/contacts/zz/notify").set(auth).send({ body: "Docs needed" })).status).toBe(404);
  });

  it("the timeline knows about the notice", async () => {
    const { pool } = await import("../db.js");
    const { loadCrmTimeline } = await import("../routes/crm/timeline.js");
    await loadCrmTimeline(true, "c1", "BF");
    const sql = String(vi.mocked(pool.query).mock.calls.at(-1)?.[0]);
    expect(sql).toMatch(/event_type IN \([^)]*'client_notice_sent'/);
    expect(sql).toContain("WHEN 'client_notice_sent' THEN ('Notice sent'");
  });
});
