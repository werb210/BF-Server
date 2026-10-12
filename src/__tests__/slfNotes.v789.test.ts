// BF_SERVER_v789_SLF_NOTES - SLF application notes read/write slf_application_notes (the old
// application_notes table never existed, so every write silently vanished behind a 201 and
// every read came back empty). A database failure is now a logged 500.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, logErrorMock } = vi.hoisted(() => ({ queryMock: vi.fn(), logErrorMock: vi.fn() }));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../observability/logger.js", async () => {
  const actual = await vi.importActual<typeof import("../observability/logger.js")>("../observability/logger.js");
  return { ...actual, logError: logErrorMock };
});

const SECRET = "test-secret-v789-slf";
const USER_ID = "00000000-0000-0000-0000-0000000000c1";
const APP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const token = () => jwt.sign({ id: USER_ID, role: "Staff", capabilities: ["application:read"] }, SECRET, { algorithm: "HS256" });

const usersRule: [RegExp, unknown] = [/FROM users WHERE id = \$1/, { rows: [{ id: USER_ID, email: null, role: "Staff", silo: "SLF", silos: ["SLF"] }] }];
const slfAppRule: [RegExp, unknown] = [/FROM applications WHERE id::text = \(\$1\)::text AND silo = 'SLF'/, { rows: [{ id: APP_ID }] }];

async function buildApp() {
  const router = (await import("../routes/slf.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/slf", router);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  queryMock.mockReset();
  logErrorMock.mockReset();
});

describe("SLF application notes (v789)", () => {
  it("GET reads slf_application_notes", async () => {
    const note = { id: "n1", text: "hello", created_at: "2026-10-01T00:00:00.000Z" };
    queryMock.mockImplementation(answerBySql([usersRule, slfAppRule, [/FROM slf_application_notes/, { rows: [note] }]]));
    const app = await buildApp();
    const res = await request(app).get(`/api/slf/applications/${APP_ID}/notes`).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([note]);
    const q = callsMatching(queryMock, /FROM slf_application_notes/);
    expect(q[0][1]).toEqual([APP_ID]);
  });

  it("POST inserts into slf_application_notes with the author", async () => {
    queryMock.mockImplementation(answerBySql([usersRule, slfAppRule, [/INSERT INTO slf_application_notes/, { rows: [], rowCount: 1 }]]));
    const app = await buildApp();
    const res = await request(app).post(`/api/slf/applications/${APP_ID}/notes`).set("Authorization", `Bearer ${token()}`).send({ text: "  a note  " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    const ins = callsMatching(queryMock, /INSERT INTO slf_application_notes/);
    expect(ins).toHaveLength(1);
    expect(ins[0][1]).toEqual([APP_ID, "a note", USER_ID]);
  });

  it("GET returns 500 and logs when the notes query fails", async () => {
    queryMock.mockImplementation(answerBySql([usersRule, slfAppRule, [/FROM slf_application_notes/, new Error("relation does not exist")]]));
    const app = await buildApp();
    const res = await request(app).get(`/api/slf/applications/${APP_ID}/notes`).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(500);
    expect(logErrorMock).toHaveBeenCalledWith("slf_notes_list_failed", expect.objectContaining({ applicationId: APP_ID, error: "relation does not exist" }));
  });

  it("POST returns 500 (not a false 201) and logs when the insert fails", async () => {
    queryMock.mockImplementation(answerBySql([usersRule, slfAppRule, [/INSERT INTO slf_application_notes/, new Error("insert failed")]]));
    const app = await buildApp();
    const res = await request(app).post(`/api/slf/applications/${APP_ID}/notes`).set("Authorization", `Bearer ${token()}`).send({ text: "x" });
    expect(res.status).toBe(500);
    expect(logErrorMock).toHaveBeenCalledWith("slf_notes_create_failed", expect.objectContaining({ applicationId: APP_ID, error: "insert failed" }));
  });

  it("a non-SLF application is still 404 and touches no notes", async () => {
    queryMock.mockImplementation(answerBySql([usersRule]));
    const app = await buildApp();
    const res = await request(app).post(`/api/slf/applications/${APP_ID}/notes`).set("Authorization", `Bearer ${token()}`).send({ text: "x" });
    expect(res.status).toBe(404);
    expect(callsMatching(queryMock, /slf_application_notes/)).toHaveLength(0);
  });

  it("the migration creates slf_application_notes", () => {
    const migration = readFileSync("migrations/2026_10_12_v789_audit2.sql", "utf-8");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS slf_application_notes");
  });

  it("no SLF notes request touches the nonexistent application_notes table", async () => {
    queryMock.mockImplementation(answerBySql([usersRule, slfAppRule, [/slf_application_notes/, { rows: [], rowCount: 1 }]]));
    const app = await buildApp();
    const auth = { Authorization: `Bearer ${token()}` };
    expect((await request(app).get(`/api/slf/applications/${APP_ID}/notes`).set(auth)).status).toBe(200);
    expect((await request(app).post(`/api/slf/applications/${APP_ID}/notes`).set(auth).send({ text: "x" })).status).toBe(201);
    expect((await request(app).get(`/api/slf/deals/${APP_ID}`).set(auth)).status).toBe(200);
    expect(callsMatching(queryMock, /\b(FROM|INTO|UPDATE|JOIN)\s+application_notes\b/i)).toHaveLength(0);
    expect(callsMatching(queryMock, /slf_application_notes/)).toHaveLength(2);
  });
});
