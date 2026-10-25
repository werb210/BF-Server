// BF_SERVER_v853_KS_PHONE_SUPPORT - the Keystone line's rules (number, hours, ring group, caller matching) and the
// support queue's rules (SLA, validation), with the database faked by SQL content.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../db.js", async () => ({
  ...(await vi.importActual<any>("../../../db.js")),
  pool: { query: h.query, connect: async () => ({ query: h.query, release: () => undefined }) },
  dbQuery: h.query,
}));

import {
  defaultQueueSettings, isKsVoiceNumber, ksCallerCard, ksVoiceNumber, matchKsCaller, parseQueueSettings, queueIsOpen, ringGroup,
} from "../ksPhone.js";
import { addWorkingMinutes, parseKsIngest, parseReply, parseTicketPatch, slaDueAt, slaState, KS_SLA_POLICY } from "../ksSupport.js";
import { parseKsUpsert } from "../ksCrm.js";
import { menuChoice } from "../../../routes/ksVoice.js";

const pool = { query: h.query };
beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([]));
});

describe("the Keystone number", () => {
  it("is off until KS_VOICE_NUMBER is set, and matches whatever way Twilio formats it", () => {
    expect(ksVoiceNumber({})).toBeNull();
    expect(isKsVoiceNumber("+15878750815", {})).toBe(false);
    const env = { KS_VOICE_NUMBER: "(587) 875-0815" };
    expect(ksVoiceNumber(env)).toBe("+15878750815");
    expect(isKsVoiceNumber("+15878750815", env)).toBe(true);
    expect(isKsVoiceNumber("15878750815", env)).toBe(true);
    expect(isKsVoiceNumber("+18666318939", env)).toBe(false);
    expect(isKsVoiceNumber("client:todd", env)).toBe(false);
  });

  it("reads the menu: 1 / sales -> sales, 2 / support -> support, anything else nothing", () => {
    expect(menuChoice("1", "")).toBe("sales");
    expect(menuChoice("2#", "")).toBe("support");
    expect(menuChoice("", "I need help with my account")).toBe("support");
    expect(menuChoice("", "pricing please")).toBe("sales");
    expect(menuChoice("9", "")).toBeNull();
    expect(menuChoice(undefined, undefined)).toBeNull();
  });
});

describe("queue hours and settings", () => {
  const settings = defaultQueueSettings("support");
  it("is open weekdays 8 to 5 Alberta time by default, and always open with hours switched off", () => {
    expect(queueIsOpen(settings, new Date("2026-10-21T16:00:00Z"))).toBe(true); // Wed 10:00 Alberta time
    expect(queueIsOpen(settings, new Date("2026-10-22T02:00:00Z"))).toBe(false); // Wed 20:00 Alberta time
    expect(queueIsOpen(settings, new Date("2026-10-24T18:00:00Z"))).toBe(false); // Saturday
    expect(queueIsOpen({ ...settings, hoursEnabled: false }, new Date("2026-10-24T18:00:00Z"))).toBe(true);
  });

  it("validates a ring group, ring time and hours", () => {
    const ok = parseQueueSettings("sales", {
      ringUserIds: ["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"],
      ringTimeoutSeconds: 30, hoursEnabled: true, timezone: "America/Regina",
      weekly: { mon: [["09:00", "17:00"]], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.ringUserIds).toHaveLength(1);
      expect(ok.value.ringTimeoutSeconds).toBe(30);
    }
    const bad = parseQueueSettings("sales", { ringUserIds: ["nope"], ringTimeoutSeconds: 5, weekly: { mon: [["17:00", "09:00"]] } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["hours", "ringTimeoutSeconds", "ringUserIds"]);
  });
});

describe("ring group", () => {
  it("rings ringable Keystone staff only, limited to the named group when one is set", async () => {
    h.query.mockImplementation(answerBySql([[/FROM users u JOIN staff_presence sp/, { rows: [{ user_id: "u1", twilio_identity: "id-1" }, { user_id: "u2", twilio_identity: null }] }]]));
    const all = await ringGroup(pool, { ringUserIds: [] });
    expect(all).toEqual([{ userId: "u1", identity: "id-1" }]);
    const [sql, params] = callsMatching(h.query, /FROM users u JOIN staff_presence sp/)[0]!;
    expect(sqlText(sql)).toContain("'KS' = ANY(");
    expect(sqlText(sql)).toContain("manual_busy");
    expect(params).toEqual([false, []]);
    await ringGroup(pool, { ringUserIds: ["11111111-1111-4111-8111-111111111111"] });
    expect(callsMatching(h.query, /FROM users u JOIN staff_presence sp/)[1]![1]).toEqual([true, ["11111111-1111-4111-8111-111111111111"]]);
  });

  it("rings nobody (logged) when the lookup fails, so the caller reaches voicemail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.query.mockImplementation(answerBySql([[/FROM users u JOIN staff_presence sp/, new Error("db down")]]));
    expect(await ringGroup(pool, { ringUserIds: [] })).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("caller matching", () => {
  it("finds a Keystone contact (and their licensee) by the last 10 digits, KS records only", async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM contacts c\s+WHERE c\.silo = 'KS'/, { rows: [{ contact_id: "c1", contact_name: "Ada Lovelace", company_id: "co1", company_name: "Acme Lending", ks_support_level: "premium", ks_stage: "paying" }] }],
    ]));
    const hit = await matchKsCaller(pool, "+1 (403) 555-0123");
    expect(hit).toMatchObject({ found: true, contactId: "c1", contactName: "Ada Lovelace", companyId: "co1", companyName: "Acme Lending", supportLevel: "premium" });
    expect(callsMatching(h.query, /FROM contacts c/)[0]![1]).toEqual(["4035550123"]);
    expect(callsMatching(h.query, /FROM companies co\s+WHERE co\.silo = 'KS'/)).toHaveLength(0);
  });

  it("falls back to a Keystone company's phone, then to nothing", async () => {
    h.query.mockImplementation(answerBySql([[/FROM companies co\s+WHERE co\.silo = 'KS'/, { rows: [{ company_id: "co9", company_name: "Beta Brokers", ks_support_level: null }] }]]));
    expect(await matchKsCaller(pool, "4035550199")).toMatchObject({ found: true, contactId: null, companyId: "co9", companyName: "Beta Brokers" });
    h.query.mockImplementation(answerBySql([]));
    expect((await matchKsCaller(pool, "4035550199")).found).toBe(false);
    expect((await matchKsCaller(pool, "anonymous")).found).toBe(false);
  });

  it("builds the card the dialler shows: name, licensee, and which Keystone line", () => {
    expect(ksCallerCard({ found: true, contactId: "c1", contactName: "Ada", companyId: "co1", companyName: "Acme", supportLevel: null, stage: null }, "support", "+14035550123"))
      .toEqual({ found: true, contactId: "c1", name: "Ada", company: "Acme", stage: "Keystone support line" });
    expect(ksCallerCard({ found: false, contactId: null, contactName: null, companyId: null, companyName: null, supportLevel: null, stage: null }, "sales", "4035550123"))
      .toEqual({ found: true, name: "Keystone sales call", company: "+14035550123", stage: "Keystone sales line" });
  });
});

describe("SLA", () => {
  it("counts business time only (weekdays 8 to 5 Alberta time) for email / priority / premium", () => {
    // Friday 4:30 pm Alberta time + 1 business hour (Premium) = Monday 8:30 am Alberta time.
    expect(addWorkingMinutes(new Date("2026-10-23T22:30:00Z"), 60, KS_SLA_POLICY.premium.window).toISOString()).toBe("2026-10-26T14:30:00.000Z");
    // Wednesday 10:00 am + 4 business hours (Priority) = 2 pm the same day.
    expect(slaDueAt("priority", new Date("2026-10-21T16:00:00Z")).toISOString()).toBe("2026-10-21T20:00:00.000Z");
    // Unknown level = the Email level: one business day (9 working hours).
    expect(slaDueAt(null, new Date("2026-10-21T16:00:00Z")).toISOString()).toBe("2026-10-22T16:00:00.000Z");
    // Dedicated: 30 minutes, 7 am to 9 pm every day.
    expect(slaDueAt("dedicated", new Date("2026-10-24T18:00:00Z")).toISOString()).toBe("2026-10-24T18:30:00.000Z");
    expect(slaDueAt("dedicated", new Date("2026-10-25T04:00:00Z")).toISOString()).toBe("2026-10-25T13:30:00.000Z");
  });

  it("reads met / missed / overdue / due soon / on track", () => {
    const now = new Date("2026-10-21T16:00:00Z");
    expect(slaState({ sla_due_at: "2026-10-21T17:00:00Z", responded_at: "2026-10-21T16:30:00Z", status: "waiting" }, now)).toBe("met");
    expect(slaState({ sla_due_at: "2026-10-21T15:00:00Z", responded_at: "2026-10-21T15:30:00Z", status: "open" }, now)).toBe("missed");
    expect(slaState({ sla_due_at: "2026-10-21T15:00:00Z", responded_at: null, status: "open" }, now)).toBe("overdue");
    expect(slaState({ sla_due_at: "2026-10-21T16:30:00Z", responded_at: null, status: "new" }, now)).toBe("due_soon");
    expect(slaState({ sla_due_at: "2026-10-21T20:00:00Z", responded_at: null, status: "new" }, now)).toBe("on_track");
    expect(slaState({ sla_due_at: null, responded_at: null, status: "new" }, now)).toBe("none");
  });
});

describe("validation", () => {
  it("the in-app help ingest names every bad field", () => {
    const ok = parseKsIngest({
      external_id: "t-1", subject: "Cannot upload", message: "The upload button does nothing",
      licensee: { company_code: "ACME", support_level: "priority" }, requester: { name: "Ada", email: "ADA@acme.example" },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.source).toBe("ks_ops");
      expect(ok.value.requester?.email).toBe("ada@acme.example");
    }
    const bad = parseKsIngest({ source: "x", message: "", priority: "asap", licensee: { support_level: "gold" }, requester: { email: "nope" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual(["external_id", "licensee", "licensee.support_level", "message", "priority", "requester.email", "source"]);
    }
  });

  it("ticket changes and replies", () => {
    expect(parseTicketPatch({ status: "waiting", assignee_user_id: null }).ok).toBe(true);
    const bad = parseTicketPatch({ status: "done", priority: "p1", assignee_user_id: "me" });
    expect(bad.ok).toBe(false);
    expect(parseTicketPatch({}).ok).toBe(false);
    const reply = parseReply({ channel: "sms", body: "On it" });
    expect(reply.ok && reply.value.status).toBe("waiting");
    expect(parseReply({ channel: "fax", body: "" }).ok).toBe(false);
    expect(parseReply({ channel: "sms", body: "x".repeat(1501) }).ok).toBe(false);
  });

  it("KS-Ops may send the licensee's support level with the company", () => {
    const ok = parseKsUpsert({ source: "licensee", external_id: "l-1", company: { name: "Acme", support_level: "premium" } });
    expect(ok.ok && ok.value.company?.support_level).toBe("premium");
    const bad = parseKsUpsert({ source: "licensee", external_id: "l-1", company: { name: "Acme", support_level: "gold" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors["company.support_level"]).toBeTruthy();
  });
});
