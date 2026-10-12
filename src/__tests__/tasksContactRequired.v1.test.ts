// BF_SERVER_TASKS_CONTACT_REQUIRED_v1 - Call/Email/SMS tasks require a contact;
// runs only include contact-attached Call/Email/SMS tasks (To-do excluded).
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: h.queryMock } };
});
vi.mock("../modules/o365/todoSync.js", () => ({ mirrorTaskToTodo: async () => undefined }));

import tasksRouter from "../routes/tasks.js";

const app = express();
app.use(express.json());
app.use("/api/tasks", tasksRouter);
const staff = () => "Bearer " + jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string, { algorithm: "HS256" });

beforeEach(() => {
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([
    [/INSERT INTO tasks/, { rows: [{ id: "task-1" }], rowCount: 1 }],
    [/FROM tasks t/, { rows: [{ id: "t1", type: "CALL", contact_id: "c1" }] }],
  ]));
});

describe("tasks contact-required", () => {
  it("create rejects Call/Email/SMS without a contact", async () => {
    for (const type of ["CALL", "EMAIL", "SMS"]) {
      const r = await request(app).post("/api/tasks").set("Authorization", staff()).send({ title: "Reach out", type });
      expect(r.status, type).toBe(400);
      expect(r.body.error.message).toBe("contact_required_for_" + type.toLowerCase());
    }
    expect(callsMatching(h.queryMock, /INSERT INTO tasks/)).toHaveLength(0);
  });

  it("a To-do may be contactless", async () => {
    const r = await request(app).post("/api/tasks").set("Authorization", staff()).send({ title: "Tidy pipeline", type: "TODO" });
    expect(r.status).toBe(200);
    expect(callsMatching(h.queryMock, /INSERT INTO tasks/)).toHaveLength(1);
  });

  it("runs exclude To-do and require a contact", async () => {
    const r = await request(app).post("/api/tasks/runs").set("Authorization", staff()).send({ view: "due_today" });
    expect(r.status).toBe(200);
    const [run] = callsMatching(h.queryMock, /FROM tasks t/);
    const where = sqlText(run[0]).split("WHERE")[1];
    expect(where).toContain("t.contact_id IS NOT NULL");
    expect(where).toContain("t.type IN ('CALL','EMAIL','SMS')");
    expect(where).not.toContain("TODO");
  });
});
