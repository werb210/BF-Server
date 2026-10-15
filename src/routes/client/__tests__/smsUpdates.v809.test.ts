// BF_SERVER_v809_SMS_UPDATES_CONSENT - the client sees and changes "Text me updates about my application" in the
// client portal. It always applies to the signed-in client's own number.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), consent: null as boolean | null }));
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});

import clientRouter from "../index.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
const token = (phone: string, role = "client") =>
  "Bearer " + jwt.sign({ sub: role + ":" + phone, role, phone, isClient: role === "client" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const UPSERT = /INSERT INTO sms_updates_consents/;

beforeEach(() => {
  h.consent = null;
  h.query.mockReset().mockImplementation(answerBySql([
    [/SELECT consent FROM sms_updates_consents WHERE phone10 = \$1/, () => ({ rows: h.consent === null ? [] : [{ consent: h.consent }] })],
    [UPSERT, { rows: [], rowCount: 1 }],
  ]));
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("v809 /api/client/sms-updates", () => {
  it("reads the signed-in client's choice; no choice reads as off", async () => {
    let r = await request(app).get("/api/client/sms-updates").set("Authorization", token("+15875550123"));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ smsUpdates: false });
    h.consent = true;
    r = await request(app).get("/api/client/sms-updates").set("Authorization", token("+15875550123"));
    expect(r.body).toEqual({ smsUpdates: true });
  });

  it("switches it on and off for the signed-in number only", async () => {
    let r = await request(app).post("/api/client/sms-updates").set("Authorization", token("+15875550123")).send({ smsUpdates: true });
    expect(r.status).toBe(200);
    expect((callsMatching(h.query, UPSERT)[0]![1] as unknown[]).slice(0, 2)).toEqual(["5875550123", true]);
    r = await request(app).post("/api/client/sms-updates").set("Authorization", token("+15875550123")).send({ smsUpdates: false, phone: "+14035550000" });
    expect(r.status).toBe(200);
    expect((callsMatching(h.query, UPSERT)[1]![1] as unknown[]).slice(0, 2)).toEqual(["5875550123", false]);
  });

  it("needs a client sign-in and a true/false value", async () => {
    expect((await request(app).get("/api/client/sms-updates")).status).toBe(401);
    expect((await request(app).post("/api/client/sms-updates").set("Authorization", token("+15875550123", "lender")).send({ smsUpdates: true })).status).toBe(401);
    expect((await request(app).post("/api/client/sms-updates").set("Authorization", token("+15875550123")).send({ smsUpdates: "yes" })).status).toBe(400);
    expect(callsMatching(h.query, UPSERT)).toHaveLength(0);
  });
});
