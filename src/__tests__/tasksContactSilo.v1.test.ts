// BF_SERVER_TASKS_CONTACT_SILO_v1 - a task attached to a contact/company takes
// that record's silo, instead of rejecting when the request's active silo lags
// the record being viewed (the contact_silo_mismatch a BI contact hit).
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), fetchBi: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: h.queryMock } };
});
vi.mock("../services/biOutreach.js", async (orig) => ({ ...(await orig<typeof import("../services/biOutreach.js")>()), fetchBiOutreachContact: h.fetchBi }));
vi.mock("../modules/o365/todoSync.js", () => ({ mirrorTaskToTodo: async () => undefined }));

import tasksRouter from "../routes/tasks.js";

const CONTACT = "c0000000-0000-4000-8000-000000000001";
const COMPANY = "c0000000-0000-4000-8000-000000000002";
const QUEUE = "c0000000-0000-4000-8000-000000000003";
const app = express();
app.use(express.json());
app.use("/api/tasks", tasksRouter);
const staff = () => "Bearer " + jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
// The request's active silo is BF; the records live elsewhere.
const create = (body: Record<string, unknown>) => request(app).post("/api/tasks").set("Authorization", staff()).set("x-silo", "BF").send({ title: "Follow up", ...body });
const insertedSilo = () => (callsMatching(h.queryMock, /INSERT INTO tasks/)[0]?.[1] as unknown[] | undefined)?.[0];

let contactSilo: string | null;
let companySilo: string | null;
let queueSilo: string;
beforeEach(() => {
  contactSilo = "BI";
  companySilo = "SLF";
  queueSilo = "BI";
  h.fetchBi.mockReset();
  h.fetchBi.mockResolvedValue({ status: "not_found" });
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [/SELECT silo FROM contacts WHERE id::text = \$1/, (_s: string, p?: unknown[]) => (p?.[0] === CONTACT && contactSilo ? { rows: [{ silo: contactSilo }], rowCount: 1 } : { rows: [], rowCount: 0 })],
    [/SELECT silo FROM companies WHERE id::text = \$1/, (_s: string, p?: unknown[]) => (p?.[0] === COMPANY && companySilo ? { rows: [{ silo: companySilo }], rowCount: 1 } : { rows: [], rowCount: 0 })],
    [/FROM task_queues WHERE id::text = \$1 AND silo = \$2/, (_s: string, p?: unknown[]) => (p?.[0] === QUEUE && p?.[1] === queueSilo ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 })],
    [/INSERT INTO tasks/, { rows: [{ id: "task-1" }], rowCount: 1 }],
  ]));
});

describe("task silo derives from the attached record", () => {
  it("derives silo from the contact when contact_id is present", async () => {
    const r = await create({ type: "CALL", contact_id: CONTACT });
    expect(r.status).toBe(200);
    expect(callsMatching(h.queryMock, /SELECT silo FROM contacts WHERE id::text = \$1/)[0][1]).toEqual([CONTACT]);
    expect(insertedSilo()).toBe("BI");
  });

  it("derives silo from the company when only company_id is present", async () => {
    const r = await create({ type: "TODO", company_id: COMPANY });
    expect(r.status).toBe(200);
    expect(callsMatching(h.queryMock, /SELECT silo FROM companies WHERE id::text = \$1/)[0][1]).toEqual([COMPANY]);
    expect(insertedSilo()).toBe("SLF");
  });

  it("a contactless to-do keeps the request silo", async () => {
    const r = await create({ type: "TODO" });
    expect(r.status).toBe(200);
    expect(insertedSilo()).toBe("BF");
  });

  it("no longer rejects with contact_silo_mismatch / company_silo_mismatch", async () => {
    for (const body of [{ type: "CALL", contact_id: CONTACT }, { type: "TODO", company_id: COMPANY }]) {
      const r = await create(body);
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toMatch(/silo_mismatch/);
    }
    // missing records are reported clearly instead
    const noContact = await create({ type: "CALL", contact_id: "c0000000-0000-4000-8000-0000000000ff" });
    expect(noContact.status).toBe(400);
    expect(noContact.body.error.message).toBe("contact_not_found");
    const noCompany = await create({ type: "TODO", company_id: "c0000000-0000-4000-8000-0000000000fe" });
    expect(noCompany.status).toBe(400);
    expect(noCompany.body.error.message).toBe("company_not_found");
  });

  it("still validates the queue against the resolved (record-derived) silo", async () => {
    const ok = await create({ type: "CALL", contact_id: CONTACT, queue_id: QUEUE });
    expect(ok.status).toBe(200);
    expect(callsMatching(h.queryMock, /FROM task_queues WHERE id::text = \$1 AND silo = \$2/)[0][1]).toEqual([QUEUE, "BI"]);
    queueSilo = "BF";
    h.queryMock.mockClear();
    const bad = await create({ type: "CALL", contact_id: CONTACT, queue_id: QUEUE });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe("queue_silo_mismatch");
    expect(callsMatching(h.queryMock, /INSERT INTO tasks/)).toHaveLength(0);
  });
});
