// BF_SERVER_v802_CLIENT_ADVISOR
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const ADVISOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const h = vi.hoisted(() => ({ query: vi.fn(), bookable: [] as Array<{ id: string }> }));
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../../../services/clientBooking.js", async (orig) => {
  const real: any = await orig();
  return { ...real, bookableStaff: async () => h.bookable };
});

import clientRouter from "../index.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
const token = (phone: string) => "Bearer " + jwt.sign({ sub: "client:" + phone, role: "client", phone, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const ADVISOR_READ = /join users u on u\.id = o\.uid/;
let advisorRows: unknown[] = [];

beforeEach(() => {
  h.query.mockReset();
  h.bookable = [];
  advisorRows = [{ id: ADVISOR, first_name: "Andrew", last_name: "Smith", profile_image_url: "https://cdn.example/andrew.png" }];
  h.query.mockImplementation(answerBySql([
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [] }],
    [/SELECT COUNT\(\*\)::text AS n FROM app_phones WHERE p10 = \$2/, (_s: string, p?: unknown[]) => ({ rows: [{ n: p?.[0] === APP && p?.[1] === OWNER.slice(-10) ? "1" : "0" }] })],
    [ADVISOR_READ, () => ({ rows: advisorRows })],
  ]));
});

describe("v802 GET /api/client/advisor", () => {
  it("answers only the owner of the application", async () => {
    const r = await request(app).get(`/api/client/advisor?applicationId=${APP}`).set("Authorization", token("+15875550199"));
    expect(r.status).toBe(404);
    expect(callsMatching(h.query, ADVISOR_READ)).toHaveLength(0);
  });

  it("returns the advisor's name, photo and whether they take bookings", async () => {
    h.bookable = [{ id: ADVISOR }];
    const r = await request(app).get(`/api/client/advisor?applicationId=${APP}`).set("Authorization", token(OWNER));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ advisor: { id: ADVISOR, firstName: "Andrew", lastName: "Smith", photoUrl: "https://cdn.example/andrew.png", bookable: true } });
    const sql = String(callsMatching(h.query, ADVISOR_READ)[0]?.[0] ?? "");
    expect(sql).toContain("u.role in ('Admin', 'Staff', 'Ops', 'Marketing')");
    expect(sql).toContain("order by o.pri");
  });

  it("leaves out a photo that is not an https link or an image", async () => {
    advisorRows = [{ id: ADVISOR, first_name: "Andrew", last_name: null, profile_image_url: "javascript:alert(1)" }];
    const r = await request(app).get(`/api/client/advisor?applicationId=${APP}`).set("Authorization", token(OWNER));
    expect(r.body.advisor).toMatchObject({ firstName: "Andrew", lastName: null, photoUrl: null, bookable: false });
  });

  it("says so when nobody is assigned", async () => {
    advisorRows = [];
    const r = await request(app).get(`/api/client/advisor?applicationId=${APP}`).set("Authorization", token(OWNER));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ advisor: null });
  });
});
