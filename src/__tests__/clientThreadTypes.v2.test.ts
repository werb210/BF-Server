// BF_CLIENT_THREAD_TYPES_v2 - the client thread query, as the route runs it.
import { beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../routes/clientDocumentsNeeded.js", async (orig) => ({ ...(await orig<any>()), computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));

import clientRouter from "../routes/client/index.js";

let thread = "";
let params: unknown[] = [];
let body: any;

beforeAll(async () => {
  h.query.mockImplementation(answerBySql([
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
    [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
    [/WITH thread AS/, { rows: [{ id: "m1", direction: "outbound", body: "Hi from staff", staff_name: "Todd", created_at: "2026-10-01T00:00:00Z" }] }],
  ]));
  const app = express();
  app.use(express.json());
  app.use("/api/client", clientRouter);
  const token = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
  const r = await request(app).get(`/api/client/messages?applicationId=${APP}`).set("Authorization", token);
  body = r.body;
  const [call] = callsMatching(h.query, /WITH thread AS/);
  thread = sqlText(call![0]).replace(/--[^\n]*/g, "");
  params = call![1] as unknown[];
});

describe("BF_CLIENT_THREAD_TYPES_v2", () => {
  it("the thread query runs and its rows reach the client", () => {
    expect(body.status).toBe("ok");
    expect(body.data.map((m: any) => m.id)).toEqual(["m1"]);
    expect(params).toEqual([APP]);
  });

  it("casts the parameter on every comparison it appears in", () => {
    // The bug: $1 was compared against applications.id and
    // communications_messages.application_id, which are different types, so no
    // single type could be deduced and the statement failed.
    expect(thread).toContain("WHERE id::text = ($1)::text");
    expect(thread).toContain("WHERE application_id::text = ($1)::text");
    // Every use of $1 is the cast form.
    expect(thread.split("$1").length - 1).toBe(thread.split("($1)::text").length - 1);
  });

  it("casts the contact comparison too", () => {
    expect(thread).toContain("contact_id::text = (SELECT contact_id::text FROM thread)");
  });

  it("leaves no uncast comparison behind", () => {
    expect(thread).not.toContain("WHERE id = $1");
    expect(thread).not.toContain("WHERE application_id = $1");
    expect(thread).not.toMatch(/=\s*\$1\b/);
  });

  it("still returns the thread scoped to the contact", () => {
    // A client with several applications must still see the single
    // conversation staff see, not one thread per application.
    expect(thread).toContain("SELECT contact_id FROM applications");
    expect(thread).toContain("(SELECT contact_id FROM thread) IS NOT NULL");
  });

  it("still anchors on the requested application", () => {
    expect(thread).toContain("($1)::text");
  });
});
