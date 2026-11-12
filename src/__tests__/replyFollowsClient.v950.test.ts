// BF_SERVER_v950_REPLY_FOLLOWS_CLIENT / BF_SERVER_v950_NO_NOTICE_ON_UPLOAD
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../services/notifications/notifyClient.js", () => ({ notifyClient: vi.fn(async () => undefined), pushToClientApp: vi.fn(async () => false) }));
vi.mock("../modules/notifications/sms.service.js", () => ({ sendSms: vi.fn(async () => ({ sid: "SM1" })) }));

import router from "../routes/communications.js";

const CONTACT = "c0c0c0c0-0000-4000-8000-000000000950";
const APP_CLIENT_WROTE_FROM = "a1a1a1a1-0000-4000-8000-000000000950";
const APP_PORTAL_GUESSED = "b2b2b2b2-0000-4000-8000-000000000950";

const app = express();
app.use(express.json());
const AUTH = () => "Bearer " + jwt.sign({ sub: "76767676-7676-4676-8676-767676767676", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
app.use("/api/communications", router);

function setup(lastInboundApp: string | null) {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/direction = 'inbound' AND type = 'message' AND application_id IS NOT NULL/, { rows: lastInboundApp ? [{ application_id: lastInboundApp }] : [] }],
    [/INSERT INTO communications_messages/, { rows: [] }],
    [/./, { rows: [] }],
  ]));
}
const inserted = () => callsMatching(h.query, /INSERT INTO communications_messages/)[0]?.[1] as unknown[] | undefined;

describe("a reply from Communications lands in the thread the client is reading", () => {
  beforeEach(() => setup(APP_CLIENT_WROTE_FROM));

  it("is stamped with the application the client last wrote from, not the one the portal guessed", async () => {
    const r = await request(app).post("/api/communications/messages/send").set("Authorization", AUTH()).send({ contactId: CONTACT, applicationId: APP_PORTAL_GUESSED, body: "It was uploaded" });
    expect(r.status).toBeLessThan(300);
    expect(inserted()?.[1]).toBe(APP_CLIENT_WROTE_FROM);
  });

  it("keeps the portal's application when the client has never written", async () => {
    setup(null);
    await request(app).post("/api/communications/messages/send").set("Authorization", AUTH()).send({ contactId: CONTACT, applicationId: APP_PORTAL_GUESSED, body: "Hello" });
    expect(inserted()?.[1]).toBe(APP_PORTAL_GUESSED);
  });

  it("a message sent from one application's own card stays on that application", async () => {
    await request(app).post("/api/communications/messages/send").set("Authorization", AUTH()).send({ applicationId: APP_PORTAL_GUESSED, body: "From the card" });
    expect(inserted()?.[1]).toBe(APP_PORTAL_GUESSED);
    expect(callsMatching(h.query, /direction = 'inbound' AND type = 'message' AND application_id IS NOT NULL/)).toHaveLength(0);
  });
});
