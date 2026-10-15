// BF_SERVER_v812_CLIENT_MSG_CONTACT_LINK - a mini-portal message links its application to the client's CRM contact
// by the signed-in client's phone (or metadata.applicant_phone), never by a column applications does not have.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
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
const APP_ID = "app-mini-portal-2"; // not a UUID: the ownership guard leaves it alone
const SECRET = process.env.JWT_SECRET || "test-secret-v812";

function backfill() {
  const calls = callsMatching(query, /UPDATE applications a\s+SET contact_id/);
  expect(calls).toHaveLength(1);
  return calls[0] as [string, unknown[]];
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  query.mockReset();
  query.mockImplementation(answerBySql([]));
});

describe("BF_SERVER_v812_CLIENT_MSG_CONTACT_LINK", () => {
  it("no longer refers to applications.applicant_phone (the column does not exist)", async () => {
    await request(app).post("/api/client/messages").send({ applicationId: APP_ID, body: "hi" });
    const [sql] = backfill();
    expect(sql).not.toMatch(/a\.applicant_phone/);
    expect(sql).toMatch(/a\.metadata->>'applicant_phone'/);
    expect(sql).toMatch(/a\.contact_id IS NULL/);
  });

  it("uses the signed-in client's phone, last 10 digits", async () => {
    const token = jwt.sign({ sub: "client:+1 (403) 555-0142", role: "client", phone: "+1 (403) 555-0142" }, SECRET, { algorithm: "HS256" });
    await request(app).post("/api/client/messages").set("Authorization", "Bearer " + token).send({ applicationId: APP_ID, body: "hi" });
    expect(backfill()[1]).toEqual([APP_ID, "4035550142"]);
  });

  it("a staff token's phone is never used to link a client's application", async () => {
    const token = jwt.sign({ sub: "u1", role: "Staff", phone: "+14035550199" }, SECRET, { algorithm: "HS256" });
    await request(app).post("/api/client/messages").set("Authorization", "Bearer " + token).send({ applicationId: APP_ID, body: "hi" });
    expect(backfill()[1]).toEqual([APP_ID, ""]);
  });

  it("the message is still saved when the link step fails", async () => {
    query.mockImplementation((sql: string, params?: unknown[]) =>
      /UPDATE applications a\s+SET contact_id/.test(sql) ? Promise.reject(new Error("boom")) : answerBySql([])(sql, params));
    const r = await request(app).post("/api/client/messages").send({ applicationId: APP_ID, body: "hi" });
    expect(r.status).toBe(201);
    expect(callsMatching(query, /INSERT INTO communications_messages/)).toHaveLength(1);
  });
});
