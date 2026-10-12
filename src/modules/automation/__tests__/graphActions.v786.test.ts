// BF_SERVER_v786_WORKFLOW_GRAPH - every v2 action, against a database that answers by SQL content.
import { describe, it, expect, vi, beforeEach } from "vitest";
import dns from "node:dns";

const postTeamAlert = vi.fn(async () => true);
vi.mock("../../../services/team/teamPhaseC.js", () => ({ postTeamAlert: (...a: any[]) => (postTeamAlert as any)(...a) }));
const enrollContactInRule = vi.fn(async () => "e-9");
vi.mock("../graphEngine.js", () => ({ enrollContactInRule: (...a: any[]) => (enrollContactInRule as any)(...a) }));

import { runGraphAction } from "../graphActions.js";
import type { EngineDeps } from "../automationContext.js";

const TPL = "11111111-1111-4111-8111-111111111111";
const LIST = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

function harness(opts: { optedOut?: boolean; consent?: boolean } = {}) {
  const calls: Array<{ sql: string; p: any[] }> = [];
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    calls.push({ sql, p });
    if (sql.includes("FROM marketing_template WHERE id::text = $1 AND channel = $2")) {
      return { rows: p[1] === "email" ? [{ name: "Welcome", subject: "Hi {{first_name}}", html: "<p>Hello {{first_name}} from {{owner_name}}</p>", body: null }] : [] };
    }
    if (sql.includes("FROM message_templates WHERE id::text = $1 AND channel = $2")) return { rows: p[1] === "sms" ? [{ name: "Nudge", subject: null, body_html: null, body_text: "Hey {{first_name}}" }] : [] };
    if (sql.includes("SELECT c.email FROM contacts c")) return { rows: opts.optedOut ? [] : [{ email: "pat@example.com" }] };
    if (sql.includes("SELECT c.phone FROM contacts c")) {
      // marketing texts pass the CASL consent gate only with consent; transactional only needs no opt-out
      const marketing = sql.includes("sms_consent");
      return { rows: marketing && !opts.consent ? [] : [{ phone: "+17805551212" }] };
    }
    if (sql.includes("::text AS id") && sql.includes("COALESCE((SELECT owner_user_id FROM applications")) return { rows: [{ id: USER }] };
    if (sql.includes("SELECT email, COALESCE(NULLIF(phone_number,''), phone) AS phone FROM users")) return { rows: [{ email: "andrew@boreal.financial", phone: "+14035550100" }] };
    if (sql.includes("UPDATE automation_rules SET rr_index")) return { rows: [{ rr_index: 2 }] };
    if (sql.includes("SELECT first_name, last_name FROM users")) return { rows: [{ first_name: "Todd", last_name: "W" }] };
    if (sql.startsWith("INSERT INTO tasks")) return { rows: [{ id: "t-1" }] };
    return { rows: [], rowCount: 1 };
  });
  const deps: EngineDeps = {
    query: query as any,
    now: () => new Date("2026-09-28T18:00:00Z"),
    sendSms: vi.fn(async () => undefined),
    notifyClient: vi.fn(async () => "app" as const),
    sendEmail: vi.fn(async () => ({ ok: true })),
    sendStaffEmail: vi.fn(async () => ({ ok: true })),
    httpFetch: vi.fn(async () => ({ ok: true, status: 200 })),
    setApplicationStage: vi.fn(async () => undefined),
  };
  const e: any = { id: "e-1", rule_id: "r-1", silo: "BF", contact_id: "c-1", application_id: "app-1",
    context: { first_name: "Pat", full_name: "Pat Lee", owner_name: "Andrew M", phone: "+17805551212", email: "pat@example.com", company: "Acme" } };
  const run = (action: string, params: Record<string, unknown>) => runGraphAction(deps, e, { id: "n1", kind: "action", action, params, next: null });
  const sqlLike = (s: string) => calls.filter((c) => c.sql.includes(s));
  return { deps, e, run, calls, sqlLike };
}

describe("v2 actions", () => {
  beforeEach(() => { postTeamAlert.mockClear(); enrollContactInRule.mockClear(); });

  it("send_email uses a saved template, personalizes it, and respects unsubscribe", async () => {
    const h = harness();
    expect(await h.run("send_email", { templateId: TPL, fromMailbox: "todd.w@boreal.financial" })).toBe("email sent: Hi Pat");
    expect(h.deps.sendEmail).toHaveBeenCalledWith({ to: "pat@example.com", subject: "Hi Pat", html: "<p>Hello Pat from Andrew M</p>", contactId: "c-1", from: "todd.w@boreal.financial" });
    expect(h.sqlLike("'email_marketing_sent'")).toHaveLength(1);
    const out = harness({ optedOut: true });
    expect(await out.run("send_email", { templateId: TPL })).toMatch(/^skip: no email or unsubscribed/);
    expect(out.deps.sendEmail).not.toHaveBeenCalled();
    await expect(harness().run("send_email", { templateId: "nope" })).rejects.toThrow(/template not found/);
  });

  it("send_sms: template or body, marketing needs consent, transactional only no opt-out", async () => {
    const h = harness({ consent: true });
    expect(await h.run("send_sms", { templateId: TPL, kind: "marketing" })).toBe("sms sent (marketing)");
    expect(h.deps.sendSms).toHaveBeenCalledWith("+17805551212", "Hey Pat");
    const noConsent = harness({ consent: false });
    expect(await noConsent.run("send_sms", { body: "Hi {{first_name}}", kind: "marketing" })).toMatch(/^skip: no consent/);
    expect(await noConsent.run("send_sms", { body: "Hi {{first_name}}", kind: "transactional" })).toBe("sms sent (transactional)");
    expect(noConsent.deps.sendSms).toHaveBeenCalledWith("+17805551212", "Hi Pat");
  });

  it("notify_client and team_post reuse the existing paths", async () => {
    const h = harness();
    expect(await h.run("notify_client", { title: "Update", body: "Hi {{first_name}}" })).toBe("client notified by app");
    expect(h.deps.notifyClient).toHaveBeenCalledWith(expect.objectContaining({ title: "Update", body: "Hi Pat", phone: "+17805551212" }));
    expect(await h.run("team_post", { channel: "#leads", body: "New lead {{full_name}}" })).toBe("posted in #leads");
    expect(postTeamAlert).toHaveBeenCalledWith("leads", "New lead Pat Lee");
  });

  it("notify_staff over in_app, sms, email and team", async () => {
    const h = harness();
    expect(await h.run("notify_staff", { channel: "in_app", to: "owner", message: "Call {{first_name}}" })).toMatch(/notified in the portal/);
    expect(h.sqlLike("INSERT INTO notifications")[0]!.p.slice(0, 3)).toEqual([USER, "e-1", "Call Pat"]);
    expect(await h.run("notify_staff", { channel: "sms", to: USER, message: "Call {{first_name}}" })).toMatch(/texted/);
    expect(h.deps.sendSms).toHaveBeenCalledWith("+14035550100", "Call Pat");
    expect(await h.run("notify_staff", { channel: "email", to: "owner", message: "Call {{first_name}}" })).toMatch(/emailed/);
    expect(h.deps.sendStaffEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "andrew@boreal.financial" }));
    expect(await h.run("notify_staff", { channel: "team", message: "Heads up" })).toBe("posted in #automations");
  });

  it("rotate_owner (round robin) and assign_owner", async () => {
    const h = harness();
    expect(await h.run("rotate_owner", { userIds: ["u-a", "u-b", "u-c"] })).toBe("owner u-b");
    expect(h.sqlLike("UPDATE contacts SET owner_id")[0]!.p).toEqual(["c-1", "u-b"]);
    expect(h.e.context.owner_name).toBe("Todd W");
    expect(await h.run("assign_owner", { userId: USER })).toBe(`owner ${USER}`);
    expect(h.sqlLike("UPDATE applications SET owner_user_id").at(-1)!.p).toEqual(["app-1", USER]);
  });

  it("create_task stores the uppercase enum values", async () => {
    const h = harness();
    expect(await h.run("create_task", { title: "Call {{first_name}}", type: "call", priority: "high", dueInHours: 2, assignee: "owner" })).toBe("task t-1");
    const p = h.sqlLike("INSERT INTO tasks")[0]!.p;
    expect(p.slice(1, 7)).toEqual(["Call Pat", null, "CALL", "HIGH", "2", null]);
    await h.run("create_task", { title: "x", type: "bogus", priority: "urgent", assignee: USER });
    expect(h.sqlLike("INSERT INTO tasks")[1]!.p.slice(3, 7)).toEqual(["TODO", "MEDIUM", "24", USER]);
  });

  it("add_note, set_contact_field, set_application_stage", async () => {
    const h = harness();
    expect(await h.run("add_note", { body: "Spoke to {{first_name}}" })).toBe("note added");
    expect(h.sqlLike("INSERT INTO crm_notes")[0]!.p).toEqual(["Spoke to Pat", "c-1", "BF"]);
    expect(await h.run("set_contact_field", { field: "lead_status", value: "Hot" })).toBe("lead_status = Hot");
    expect(h.sqlLike("UPDATE contacts SET lead_status = $2")).toHaveLength(1);
    expect(await h.run("set_contact_field", { field: "password_hash", value: "x" })).toMatch(/^skip:/);
    expect(await h.run("set_application_stage", { stage: "In Review" })).toBe("stage In Review");
    expect(h.deps.setApplicationStage).toHaveBeenCalledWith("app-1", "In Review");
  });

  it("add_tag / remove_tag and add_to_list / remove_from_list", async () => {
    const h = harness();
    expect(await h.run("add_tag", { tag: "vip" })).toBe("tag vip");
    expect(await h.run("remove_tag", { tag: "vip" })).toBe("untag vip");
    expect(h.sqlLike("array_remove")).toHaveLength(1);
    expect(await h.run("add_to_list", { listId: LIST })).toBe(`added to list ${LIST}`);
    expect(h.sqlLike("INSERT INTO automation_list_members")[0]!.p).toEqual([LIST, "c-1"]);
    expect(await h.run("remove_from_list", { listId: LIST })).toBe(`removed from list ${LIST}`);
    expect(h.sqlLike("DELETE FROM automation_list_members")).toHaveLength(1);
  });

  it("webhook: https only, sends the chosen fields, 10 s timeout, failures logged and thrown", async () => {
    // BF_SERVER_v789_SSRF_GUARD - the step now resolves the host first; answer DNS with a public address.
    vi.spyOn(dns.promises, "lookup").mockImplementation((async () => [{ address: "93.184.216.34", family: 4 }]) as any);
    const h = harness();
    expect(await h.run("webhook", { url: "https://hooks.example.com/x", method: "POST", includeFields: ["first_name", "company"] })).toBe("webhook hooks.example.com 200");
    const [url, init] = (h.deps.httpFetch as any).mock.calls[0];
    expect(url).toBe("https://hooks.example.com/x");
    expect(JSON.parse(init.body)).toMatchObject({ contactId: "c-1", first_name: "Pat", company: "Acme" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    await expect(h.run("webhook", { url: "http://insecure.example.com" })).rejects.toThrow(/https/);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (h.deps.httpFetch as any).mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(h.run("webhook", { url: "https://hooks.example.com/x" })).rejects.toThrow(/500/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    vi.restoreAllMocks();
  });

  it("enroll_workflow enrolls the contact in the other workflow", async () => {
    const h = harness();
    expect(await h.run("enroll_workflow", { workflowId: "r-2" })).toBe("enrolled in workflow r-2");
    expect(enrollContactInRule).toHaveBeenCalledWith(h.deps, "r-2", expect.objectContaining({ contactId: "c-1", silo: "BF" }));
  });
});
