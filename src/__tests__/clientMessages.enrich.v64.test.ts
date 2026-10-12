// BF_SERVER_v64_CLIENT_MSG_ENRICH - a mini-portal message must carry the application's
// contact_id and silo, or the staff Communications view (filtered by both) never shows it.
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const query = vi.fn();
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (...a: unknown[]) => query(...a);
  return { ...real, dbQuery: q, pool: { query: q } };
});
vi.mock("../services/notifications/staffSms.js", () => ({ sendStaffNotification: async () => undefined }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));
import clientRouter from "../routes/client/index.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);

const APP_ID = "app-mini-portal-1"; // not a UUID: the ownership guard leaves it alone

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(answerBySql([]));
});

describe("BF_SERVER_v64_CLIENT_MSG_ENRICH", () => {
  it("INSERT into communications_messages takes contact_id and silo from the application", async () => {
    const r = await request(app).post("/api/client/messages").send({ applicationId: APP_ID, body: "hello there" });
    expect(r.status).toBe(201);
    const insert = callsMatching(query, /INSERT INTO communications_messages/);
    expect(insert).toHaveLength(1);
    const [sql, params] = insert[0] as [string, unknown[]];
    expect(sql).toMatch(/\(id, type, direction, status, application_id, contact_id, silo, body, attachments, created_at\)/);
    expect(sql).toMatch(/SELECT contact_id FROM applications WHERE id = \$2/);
    expect(sql).toMatch(/SELECT silo FROM applications WHERE id = \$2/);
    expect(params[0]).toBe(r.body.data.id);
    expect(params[1]).toBe(APP_ID);
    expect(params[2]).toBe("hello there");
  });

  it("backfills the application's contact_id before inserting the message", async () => {
    await request(app).post("/api/client/messages").send({ applicationId: APP_ID, body: "x" });
    const calls = query.mock.calls.map((c) => String(c[0]));
    const backfill = calls.findIndex((s) => /UPDATE applications a\s+SET contact_id = c\.id/.test(s));
    const insert = calls.findIndex((s) => s.includes("INSERT INTO communications_messages"));
    expect(backfill).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(backfill);
  });

  it("refuses a message without an application", async () => {
    const r = await request(app).post("/api/client/messages").send({ body: "x" });
    expect(r.status).toBe(400);
    expect(callsMatching(query, /INSERT INTO communications_messages/)).toHaveLength(0);
  });
});
