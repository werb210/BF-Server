// BF_SERVER_v789_MAYA_TASKS_ON_TASKS - Maya's crm.tasks / crm.create_task tools read and write
// the unified tasks table (crm_tasks is retired) with UPPERCASE values that pass its CHECKs and a
// non-null assignee_user_id; the read keeps the lowercase status/priority Maya already knows.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock } };
});

const SECRET = "test-secret-v789-maya-tasks";
const CONTACT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const STAFF_ID = "00000000-0000-0000-0000-0000000000d1";

async function buildApp() {
  const router = (await import("../routes/mayaStaff.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/maya", router);
  return app;
}

const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, SECRET, { algorithm: "HS256" });

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
});

describe("Maya crm-tasks on the unified tasks table", () => {
  it("crm-tasks reads tasks (not crm_tasks) and maps values back for Maya", async () => {
    queryMock.mockImplementation(answerBySql([
      [/crm_tasks/, new Error("crm_tasks is retired")],
      [/FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id/, { rows: [
        { id: "t1", title: "Call back", status: "open", priority: "high", due_at: null, assignee_name: "Sam Staff" },
      ] }],
    ]));
    const app = await buildApp();
    const res = await request(app).post("/api/maya/staff/crm-tasks").set("Authorization", svc()).send({ contact_id: CONTACT_ID, silo: "bi" });
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([{ id: "t1", title: "Call back", status: "open", priority: "high", dueAt: null, assignee: "Sam Staff" }]);
    const q = callsMatching(queryMock, /FROM tasks t/);
    expect(String(q[0][0])).toContain("CASE t.status WHEN 'COMPLETED' THEN 'done' ELSE 'open' END AS status");
    expect(String(q[0][0])).toContain("t.deleted_at IS NULL");
    expect(q[0][1]).toEqual([CONTACT_ID, "BI"]);
  });

  it("crm-create-task inserts UPPERCASE values into tasks with an assignee", async () => {
    queryMock.mockImplementation(answerBySql([
      [/crm_tasks/, new Error("crm_tasks is retired")],
      [/INSERT INTO tasks/, { rows: [{ id: "new-task" }] }],
    ]));
    const app = await buildApp();
    const res = await request(app).post("/api/maya/staff/crm-create-task").set("Authorization", svc())
      .send({ contact_id: CONTACT_ID, title: "Follow up", priority: "high", silo: "slf", staff_user_id: STAFF_ID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: "new-task" });
    const ins = callsMatching(queryMock, /INSERT INTO tasks/);
    const sql = String(ins[0][0]);
    expect(sql).toContain("'TODO', 'NOT_STARTED'");
    expect(sql).toContain("'API'");
    expect(sql).toContain("COALESCE(s.id, c.owner_id) AS assignee");
    expect(sql).toContain("a.assignee IS NOT NULL");
    expect(ins[0][1]).toEqual(["SLF", "Follow up", null, "HIGH", null, CONTACT_ID, STAFF_ID]);
  });

  it("crm-create-task maps an unknown priority/silo to NONE/BF", async () => {
    queryMock.mockImplementation(answerBySql([[/INSERT INTO tasks/, { rows: [{ id: "x" }] }]]));
    const app = await buildApp();
    await request(app).post("/api/maya/staff/crm-create-task").set("Authorization", svc())
      .send({ contact_id: CONTACT_ID, title: "T", priority: "urgent", silo: "zz" });
    const ins = callsMatching(queryMock, /INSERT INTO tasks/);
    expect((ins[0][1] as unknown[])[0]).toBe("BF");
    expect((ins[0][1] as unknown[])[3]).toBe("NONE");
  });

  it("crm-create-task with no resolvable assignee is a 400, not a NOT NULL crash", async () => {
    queryMock.mockImplementation(answerBySql([[/INSERT INTO tasks/, { rows: [] }]]));
    const app = await buildApp();
    const res = await request(app).post("/api/maya/staff/crm-create-task").set("Authorization", svc())
      .send({ contact_id: CONTACT_ID, title: "T" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: "assignee_required" });
  });

  it("still requires the Maya service token", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/maya/staff/crm-create-task").send({ contact_id: CONTACT_ID, title: "T" });
    expect(res.status).toBe(401);
    expect(callsMatching(queryMock, /INSERT INTO tasks/)).toHaveLength(0);
  });
});
