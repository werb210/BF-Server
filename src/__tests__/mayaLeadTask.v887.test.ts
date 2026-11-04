// BF_SERVER_v887_MAYA_LEAD_TASK - a lead Maya captures in the website chat gets a call-back task for its owner.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { callBackTitle, createMayaLeadFollowUp, dueTodayAlberta, isMayaWebsiteLead } from "../leads/mayaLeadFollowUp.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock } };
});

const SECRET = "test-secret-v887-maya-task";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000a1";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ROTATED_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const userRow = { rows: [{ id: ADMIN_ID, email: null, role: "Admin", silo: "BF", silos: ["BF"] }] };
const db = { query: (sql: string, params?: unknown[]) => queryMock(sql, params) };

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  queryMock.mockReset().mockImplementation(answerBySql([]));
});

describe("Maya lead follow-up task (v887)", () => {
  it("only Maya's website lead sources count", () => {
    expect(isMayaWebsiteLead("maya_visitor_tool")).toBe(true);
    expect(isMayaWebsiteLead("maya_visitor_intake")).toBe(true);
    expect(isMayaWebsiteLead("website")).toBe(false);
    expect(isMayaWebsiteLead(undefined)).toBe(false);
  });

  it("is titled 'Call back <name>: website chat lead'", () => {
    expect(callBackTitle("Pat Example")).toBe("Call back Pat Example: website chat lead");
    expect(callBackTitle("")).toBe("Call back the website visitor: website chat lead");
  });

  it("is due today on the Alberta clock: 5 pm, or the end of the day after 5 pm", () => {
    // Alberta is UTC-6 all year. 2026-11-04 11:00 in Alberta = 17:00 UTC -> 5 pm Alberta = 23:00 UTC
    expect(dueTodayAlberta(new Date("2026-11-04T17:00:00Z")).toISOString()).toBe("2026-11-04T23:00:00.000Z");
    // 2026-11-04 19:30 in Alberta = 2026-11-05 01:30 UTC -> 23:59 the same Alberta day
    expect(dueTodayAlberta(new Date("2026-11-05T01:30:00Z")).toISOString()).toBe("2026-11-05T05:59:00.000Z");
  });

  it("creates a CALL task linked to the contact for the rotated owner", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM tasks\s+WHERE contact_id/, { rows: [] }],
      [/app_settings|settings_pack|lead_rotation:/, { rows: [] }],
      [/AS user_id/, (_sql: string, params?: unknown[]) => ({ rows: [{ user_id: (params as unknown[])[1] ?? OWNER_ID }] })],
      [/INSERT INTO tasks/, { rows: [{ id: "task-1" }] }],
    ]));
    const r = await createMayaLeadFollowUp(db, { contactId: CONTACT, silo: "BF", name: "Pat Example", isNewContact: false }, new Date("2026-11-04T17:00:00Z"));
    expect(r).toEqual({ created: true, taskId: "task-1", assigneeUserId: OWNER_ID });
    const ins = callsMatching(queryMock, /INSERT INTO tasks/);
    expect(ins).toHaveLength(1);
    expect(String(ins[0][0])).toContain("'CALL'");
    const p = ins[0][1] as unknown[];
    expect(p[0]).toBe("BF");
    expect(p[1]).toBe("Call back Pat Example: website chat lead");
    expect(p[3]).toBe("2026-11-04T23:00:00.000Z");
    expect(p[4]).toBe(OWNER_ID);
    expect(p[5]).toBe(CONTACT);
  });

  it("owner order is rotation, then contact owner, then an Admin", async () => {
    queryMock.mockImplementation(answerBySql([[/INSERT INTO tasks/, { rows: [{ id: "t" }] }]]));
    await createMayaLeadFollowUp(db, { contactId: CONTACT, silo: "BF", name: "Pat", isNewContact: false });
    const sql = String(callsMatching(queryMock, /AS user_id/)[0][0]);
    expect(sql).toMatch(/COALESCE\(\$2::uuid, \(SELECT owner_id FROM contacts WHERE id::text = \$1\), \(SELECT id FROM users WHERE active = true .*role = 'Admin'/s);
  });

  it("skips when the contact already has an open task from the last 24 hours", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM tasks\s+WHERE contact_id/, { rows: [{ id: "open-1" }] }]]));
    const r = await createMayaLeadFollowUp(db, { contactId: CONTACT, silo: "BF", name: "Pat", isNewContact: true });
    expect(r).toEqual({ created: false, reason: "open_task_exists" });
    const check = String(callsMatching(queryMock, /FROM tasks\s+WHERE contact_id/)[0][0]);
    expect(check).toContain("interval '24 hours'");
    expect(check).toContain("status NOT IN ('COMPLETED','DEFERRED')");
    expect(callsMatching(queryMock, /INSERT INTO tasks/)).toHaveLength(0);
  });

  it("does not guess when nobody can own it", async () => {
    queryMock.mockImplementation(answerBySql([[/AS user_id/, { rows: [{ user_id: null }] }]]));
    const r = await createMayaLeadFollowUp(db, { contactId: CONTACT, silo: "BF", name: "Pat", isNewContact: false });
    expect(r).toEqual({ created: false, reason: "no_assignee" });
  });
});

describe("POST /api/crm/startup-waitlist creates the task for Maya leads only (v887)", () => {
  async function post(body: Record<string, unknown>) {
    const router = (await import("../routes/crm.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/crm", router);
    const t = jwt.sign({ id: ADMIN_ID, role: "Admin", capabilities: ["crm:read", "crm:write"] }, SECRET, { algorithm: "HS256" });
    return request(app).post("/api/crm/startup-waitlist").set("Authorization", `Bearer ${t}`).send(body);
  }
  const rules = () => answerBySql([
    [/FROM users WHERE id/, userRow],
    [/from contacts\s+where silo = \$3/, { rows: [] }],
    [/insert into contacts/i, { rows: [{ id: CONTACT }] }],
    [/FROM tasks\s+WHERE contact_id/, { rows: [] }],
    [/AS user_id/, { rows: [{ user_id: ROTATED_ID }] }],
    [/INSERT INTO tasks/, { rows: [{ id: "task-9" }] }],
  ]);

  it("a lead from Maya's lead.capture gets a follow-up task", async () => {
    queryMock.mockImplementation(rules());
    const res = await post({ name: "Robin Sample", email: "robin@example.com", source: "maya_visitor_tool", channel: "website" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: CONTACT, created: true, followUpTaskId: "task-9" });
    const ins = callsMatching(queryMock, /INSERT INTO tasks/);
    expect(ins).toHaveLength(1);
    expect((ins[0][1] as unknown[])[1]).toBe("Call back Robin Sample: website chat lead");
  });

  it("the website waitlist form (not Maya) does not", async () => {
    queryMock.mockImplementation(rules());
    const res = await post({ name: "Robin Sample", email: "robin@example.com", list: "under_10k" });
    expect(res.body).toMatchObject({ ok: true, followUpTaskId: null });
    expect(callsMatching(queryMock, /INSERT INTO tasks/)).toHaveLength(0);
  });

  it("a task failure never loses the lead", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM users WHERE id/, userRow],
      [/from contacts\s+where silo = \$3/, { rows: [] }],
      [/insert into contacts/i, { rows: [{ id: CONTACT }] }],
      [/FROM tasks\s+WHERE contact_id/, new Error("tasks table locked")],
    ]));
    const res = await post({ name: "Robin Sample", phone: "+15555550142", source: "maya_visitor_intake" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: CONTACT, created: true, followUpTaskId: null });
  });
});
