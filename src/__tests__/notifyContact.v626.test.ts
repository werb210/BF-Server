// BF_SERVER_NOTIFY_CONTACT_v626
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const state = vi.hoisted(() => ({ contact: null as any, inserts: [] as any[], pushOk: false, smsSent: [] as any[], biCalls: [] as any[] }));

vi.mock("../db.js", () => ({
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
  it("route and timeline know about the notice", () => {
    expect(readFileSync("src/routes/crm.ts", "utf8")).toContain('"/contacts/:id/notify"');
    expect(readFileSync("src/routes/crm/timeline.ts", "utf8")).toContain("'client_notice_sent'");
  });
});
