// Maya CRM tools: read + act endpoints for notes and tasks.
// BF_SERVER_v789_MAYA_TASKS_ON_TASKS - crm_tasks is retired; Maya writes the unified tasks table.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../services/notes/mentions.js", () => ({ parseAndResolveMentions: async () => [] }));

import mayaStaff from "../routes/mayaStaff.js";

const CONTACT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const app = express();
app.use(express.json());
app.use("/api/maya", mayaStaff);
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const post = (p: string, body: Record<string, unknown>) => request(app).post("/api/maya" + p).set("Authorization", svc()).send(body);

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/crm_tasks/, new Error("crm_tasks is retired")],
    [/FROM crm_notes n/, { rows: [{ id: "n1", body: "Called, no answer", created_at: "2026-10-01", owner_name: "Sam" }] }],
    [/INSERT INTO crm_notes/, { rows: [{ id: "n2" }] }],
    [/FROM tasks t/, { rows: [{ id: "t1", title: "Follow up", status: "open", priority: "high", due_at: null, assignee_name: "Sam" }] }],
    [/INSERT INTO tasks/, { rows: [{ id: "t2" }] }],
  ]));
});

describe("Maya CRM tools", () => {
  it("exposes read+act CRM endpoints behind the service token", async () => {
    for (const p of ["/staff/crm-notes", "/staff/crm-add-note", "/staff/crm-tasks", "/staff/crm-create-task"]) {
      const r = await request(app).post("/api/maya" + p).send({ contact_id: CONTACT_ID });
      expect(r.status, p).toBe(401);
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("crm-notes reads the contact's notes", async () => {
    const r = await post("/staff/crm-notes", { contact_id: CONTACT_ID });
    expect(r.status).toBe(200);
    expect(r.body.notes).toEqual([{ id: "n1", body: "Called, no answer", at: "2026-10-01", owner: "Sam" }]);
    expect(callsMatching(queryMock, /FROM crm_notes n/)[0][1]).toEqual([CONTACT_ID]);
  });

  it("crm-add-note inserts into crm_notes", async () => {
    const r = await post("/staff/crm-add-note", { contact_id: CONTACT_ID, body: "Left a voicemail", silo: "BF" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: "n2" });
    const ins = callsMatching(queryMock, /INSERT INTO crm_notes/);
    expect(ins).toHaveLength(1);
    expect(ins[0][1]).toEqual(["Left a voicemail", CONTACT_ID, "BF", []]);
  });

  it("crm-tasks reads the tasks table", async () => {
    const r = await post("/staff/crm-tasks", { contact_id: CONTACT_ID });
    expect(r.status).toBe(200);
    expect(r.body.tasks).toHaveLength(1);
  });

  it("crm-create-task inserts into tasks, never crm_tasks", async () => {
    const r = await post("/staff/crm-create-task", { contact_id: CONTACT_ID, title: "Call back" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: "t2" });
    expect(callsMatching(queryMock, /INSERT INTO tasks/)).toHaveLength(1);
    expect(callsMatching(queryMock, /INSERT INTO crm_tasks/)).toHaveLength(0);
    expect(callsMatching(queryMock, /crm_tasks/)).toHaveLength(0);
  });

  it("act endpoints reject a request missing what they write", async () => {
    expect((await post("/staff/crm-add-note", { contact_id: CONTACT_ID })).status).toBe(400);
    expect((await post("/staff/crm-create-task", { contact_id: CONTACT_ID })).status).toBe(400);
    expect(callsMatching(queryMock, /INSERT INTO/).filter((c) => !String(c[0]).includes("maya_audit"))).toHaveLength(0);
  });
});
