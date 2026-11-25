// BF_SERVER_CRM_FLOWS_v1 - flow rules, job ids, footers and the worker's send step (database answered by SQL content).
import { describe, expect, it, vi } from "vitest";
vi.mock("../../db.js", () => ({ pool: { query: vi.fn() } }));
import { flowJobId, parseFlowJobId, withFooter, nextAfterSend, onOpen, onClick } from "../flowEngine.js";
import { isBiEvent } from "../../routes/sendgridWebhook.js";
import { sendDue, isSuppressed } from "../flowWorker.js";
import { starterEmails } from "../flowStarters.js";

const FLOW = "11111111-2222-3333-4444-555555555555";
const CONTACT = "99999999-8888-7777-6666-555555555555";

describe("CRM flows", () => {
  it("uses its own job id so the webhook never forwards these events to BI", () => {
    const id = flowJobId(FLOW, "e1");
    expect(id).toBe(`crmflow:${FLOW}:e1`);
    expect(parseFlowJobId(id)).toEqual({ flowId: FLOW, key: "e1" });
    expect(parseFlowJobId(`flow:${FLOW}:e1`)).toBeNull();
    expect(isBiEvent({ job_id: id })).toBe(false);
  });

  it("signs each business's emails with its own name, postal address and an unsubscribe link", () => {
    const ks = withFooter("<p>Hi</p>", "Keystone", "KS");
    expect(ks).toContain("Keystone (2630108 Alberta Ltd.), 450 Sparling Crt SW");
    expect(ks).toContain("Unsubscribe");
    expect(withFooter("<p>Hi</p>", "Boreal Financial", "BF")).toContain("Boreal Financial, 450 Sparling Crt SW");
  });

  it("keeps the BI rules: no open -> weekly follow-ups; open -> more details; click -> let's talk", () => {
    const now = new Date("2026-11-24T17:00:00Z");
    expect(nextAfterSend("e1", "none", now)?.key).toBe("n2");
    expect(onOpen({ track: "none", sentKeys: ["e1"], lastSentAt: now }, now)?.next?.key).toBe("o1");
    expect(onClick({ track: "none", sentKeys: ["e1"], lastSentAt: new Date(now.getTime() - 3_600_000) }, { at: now, url: "https://keystonecrm.online" })?.next?.key).toBe("c1");
  });

  it("has starter wording for all seven emails in each business", () => {
    for (const silo of ["BF", "KS"]) expect(Object.keys(starterEmails(silo)).sort()).toEqual(["c1", "e1", "n2", "n3", "n4", "o1", "o2"]);
  });

  it("never emails a suppressed address, from any business", async () => {
    const db = { query: vi.fn(async (sql: string) => (sql.includes("email_suppressions") ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 })) };
    expect(await isSuppressed(db as any, CONTACT, "x@example.com")).toBe(true);
  });

  it("sends a due email with the flow's job id and moves the person on", async () => {
    const updates: any[] = [];
    const db = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes("FROM crm_flow_members m") && sql.includes("JOIN crm_flows f")) {
          return { rows: [{ id: "m1", flow_id: FLOW, contact_id: CONTACT, track: "none", next_key: "e1", failures: 0, silo: "KS", flow_name: "Brokers",
            emails: { e1: { subject: "Hi {{first_name}}", body: "<p>Hello {{company}}</p>" } }, from_name: "Todd at Keystone", from_email: "sales@keystonecrm.online",
            reply_to: "sales@keystonecrm.online", link_url: "https://keystonecrm.online", booking_url: "", first_name: "Ann", full_name: "Ann Lee", company_name: "Lee Capital", contact_email: "ann@example.com" }] };
        }
        if (sql.includes("email_suppressions")) return { rows: [], rowCount: 0 };
        if (sql.includes("UPDATE crm_flow_members")) updates.push(params);
        return { rows: [], rowCount: 0 };
      }),
    };
    const send = vi.fn(async () => ({ ok: true }));
    const out = await sendDue(db as any, { send }, new Date("2026-11-24T17:00:00Z")); // 11:00 in Alberta, a Tuesday
    expect(out.sent).toBe(1);
    const m = (send.mock.calls[0] as any[])[0];
    expect(m.subject).toBe("Hi Ann");
    expect(m.fromEmail).toBe("sales@keystonecrm.online");
    expect(m.customArgs.job_id).toBe(`crmflow:${FLOW}:e1`);
    expect(m.html).toContain("Keystone (2630108 Alberta Ltd.)");
    expect(updates[0]?.[3]).toBe("n2");
  });

  // BF_SERVER_FLOW_SECOND_ADDRESS_v1
  it("after the last unopened email, starts the flow again on the second address a week later", async () => {
    const updates: Array<{ sql: string; params: any[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes("FROM crm_flow_members m") && sql.includes("JOIN crm_flows f")) {
          return { rows: [{ id: "m1", flow_id: FLOW, contact_id: CONTACT, track: "none", next_key: "n4", failures: 0, round: 1, member_email: "ann@example.com", silo: "KS", flow_name: "Brokers",
            emails: { n4: { subject: "Last note", body: "<p>Bye</p>" } }, from_name: "", from_email: null, reply_to: null, link_url: "", booking_url: "",
            first_name: "Ann", full_name: "Ann Lee", company_name: "Lee Capital", contact_email: "ann@example.com", secondary_email: "Ann.Lee@Other.com" }] };
        }
        if (sql.includes("email_suppressions")) return { rows: [], rowCount: 0 };
        if (sql.includes("lower(email) = $2 AND id <> $3")) return { rows: [], rowCount: 0 };
        if (sql.includes("UPDATE crm_flow_members")) updates.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
    };
    const send = vi.fn(async () => ({ ok: true }));
    const now = new Date("2026-11-24T17:00:00Z");
    await sendDue(db as any, { send }, now);
    const restart = updates.find((u) => u.sql.includes("round = 2"));
    expect(restart?.params[1]).toBe("ann.lee@other.com");
    expect(new Date(restart?.params[2]).getTime() - now.getTime()).toBeGreaterThanOrEqual(7 * 86_400_000);
  });

  it("sends the second round to the second address and never restarts it again", async () => {
    const updates: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM crm_flow_members m") && sql.includes("JOIN crm_flows f")) {
          return { rows: [{ id: "m1", flow_id: FLOW, contact_id: CONTACT, track: "none", next_key: "n4", failures: 0, round: 2, member_email: "ann.lee@other.com", silo: "KS", flow_name: "Brokers",
            emails: { n4: { subject: "Last note", body: "<p>Bye</p>" } }, from_name: "", from_email: null, reply_to: null, link_url: "", booking_url: "",
            first_name: "Ann", full_name: "Ann Lee", company_name: "Lee Capital", contact_email: "ann@example.com", secondary_email: "ann.lee@other.com" }] };
        }
        if (sql.includes("UPDATE crm_flow_members")) updates.push(sql);
        return { rows: [], rowCount: 0 };
      }),
    };
    const send = vi.fn(async () => ({ ok: true }));
    await sendDue(db as any, { send }, new Date("2026-11-24T17:00:00Z"));
    expect((send.mock.calls[0] as any[])[0].to).toBe("ann.lee@other.com");
    expect(updates.some((u) => u.includes("round = 2"))).toBe(false);
  });

  it("does nothing without a different second address", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const { startSecondRound } = await import("../flowWorker.js");
    expect(await startSecondRound(db as any, { id: "m1", flow_id: FLOW, contact_id: CONTACT, secondary_email: "ANN@example.com" }, "ann@example.com", new Date())).toBe(false);
    expect(await startSecondRound(db as any, { id: "m1", flow_id: FLOW, contact_id: CONTACT, secondary_email: null }, "ann@example.com", new Date())).toBe(false);
  });
});
