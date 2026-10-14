// BF_SERVER_v807_CLIENT_PROFILE - the client edits name, email and business name in Settings; the CRM contact
// and the application are updated. Only the signed-in owner of the file may do it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});

import clientRouter, { cleanProfileInput } from "../index.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
const token = (phone: string) => "Bearer " + jwt.sign({ sub: "client:" + phone, role: "client", phone, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const APP_UPDATE = /UPDATE applications\s+SET name = \$2/;
const CONTACT_UPDATE = /UPDATE contacts SET first_name = \$2/;
const BODY = { applicationId: APP, firstName: " Todd ", lastName: "Werboweski", email: "Todd@Example.com", businessName: "Northern Lights Bakery" };

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [] }],
    [/SELECT COUNT\(\*\)::text AS n FROM app_phones WHERE p10 = \$2/, (_s: string, p?: unknown[]) => ({ rows: [{ n: p?.[0] === APP && p?.[1] === OWNER.slice(-10) ? "1" : "0" }] })],
    [APP_UPDATE, { rows: [{ contact_id: CONTACT }] }],
    [CONTACT_UPDATE, { rows: [] }],
  ]));
});

describe("v807 POST /api/client/profile", () => {
  it("updates the application and the CRM contact for the owner", async () => {
    const r = await request(app).post("/api/client/profile").set("Authorization", token(OWNER)).send(BODY);
    expect(r.status).toBe(200);
    expect(r.body.profile).toEqual({ firstName: "Todd", lastName: "Werboweski", email: "todd@example.com", businessName: "Northern Lights Bakery" });
    expect(callsMatching(h.query, APP_UPDATE)[0]?.[1]).toEqual([APP, "Northern Lights Bakery", "Todd", "Werboweski", "todd@example.com"]);
    expect(callsMatching(h.query, CONTACT_UPDATE)[0]?.[1]).toEqual([CONTACT, "Todd", "Werboweski", "Todd Werboweski", "todd@example.com", "Northern Lights Bakery"]);
  });

  it("refuses someone who does not own the file, and changes nothing", async () => {
    const r = await request(app).post("/api/client/profile").set("Authorization", token("+15875550199")).send(BODY);
    expect([403, 404]).toContain(r.status);
    expect(callsMatching(h.query, APP_UPDATE)).toHaveLength(0);
    expect(callsMatching(h.query, CONTACT_UPDATE)).toHaveLength(0);
  });

  it("checks the input", async () => {
    expect(cleanProfileInput({ firstName: "A", lastName: "B", email: "nope", businessName: "C" })).toEqual({ ok: false, error: "email_invalid" });
    expect(cleanProfileInput({ firstName: "", lastName: "B", email: "a@b.co", businessName: "C" })).toEqual({ ok: false, error: "first_name_required" });
    const r = await request(app).post("/api/client/profile").set("Authorization", token(OWNER)).send({ ...BODY, email: "bad" });
    expect(r.status).toBe(400);
    expect(callsMatching(h.query, APP_UPDATE)).toHaveLength(0);
  });
});
