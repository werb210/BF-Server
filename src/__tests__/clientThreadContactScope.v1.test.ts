import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const migration = readFileSync(
  fileURLToPath(new URL("../../migrations/2026_07_30_v2830_email_template_second_column.sql", import.meta.url)),
  "utf-8",
);

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../middleware/auth.js", async (orig) => {
  const real: any = await orig();
  const pass = (_req: any, _res: any, next: any) => next();
  return { ...real, requireAuth: pass, requireCapability: () => pass, requireAuthorization: () => pass };
});
vi.mock("../routes/clientDocumentsNeeded.js", async (orig) => ({ ...(await orig<any>()), computeOutstandingDocs: async () => ({ required: [], stillNeeded: [], rejected: [] }) }));

import clientRouter from "../routes/client/index.js";
import marketing from "../routes/marketing.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { if (req.path.startsWith("/api/marketing")) req.user = { userId: "u1", role: "Admin", silo: "BF" }; next(); });
app.use("/api/client", clientRouter);
app.use("/api/marketing", marketing);
const ownerToken = "Bearer " + jwt.sign({ sub: "client:" + OWNER, role: "client", phone: OWNER, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });

describe("BF_CLIENT_THREAD_CONTACT_SCOPE_v1", () => {
  let thread = "";
  let body: any;
  beforeAll(async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP }] }],
      [/WITH app_phones AS/, { rows: [{ total: 1, mine: 1, known: 1 }] }],
      // A staff reply stamped on the contact only, and one on this application.
      [/WITH thread AS/, { rows: [
        { id: "contact-level", direction: "outbound", body: "Reply on the contact", staff_name: "Todd", created_at: "2026-10-01T00:00:00Z" },
        { id: "app-level", direction: "inbound", body: "Question", staff_name: null, created_at: "2026-10-02T00:00:00Z" },
      ] }],
    ]));
    const r = await request(app).get(`/api/client/messages?applicationId=${APP}`).set("Authorization", ownerToken);
    body = r.body;
    const [call] = callsMatching(h.query, /WITH thread AS/);
    thread = sqlText(call![0]).replace(/--[^\n]*/g, "");
    expect(call![1]).toEqual([APP]);
  });

  it("widens the client thread beyond a single application", () => {
    expect(thread).toMatch(/^\s*WITH thread AS \(/);
    expect(thread).toContain("contact_id::text = (SELECT contact_id::text FROM thread)");
    expect(body.data.map((m: any) => m.id)).toEqual(["contact-level", "app-level"]);
  });

  it("still anchors the thread on the requested application", () => {
    expect(thread).toContain("WHERE application_id::text = ($1)::text");
    expect(thread).toContain("SELECT contact_id FROM applications WHERE id::text = ($1)::text LIMIT 1");
  });
});

describe("BF_EMAIL_TEMPLATE_SECOND_COLUMN_v1", () => {
  beforeEach(() => { h.query.mockReset(); });

  it("adds the four columns idempotently", () => {
    for (const col of ["headline2", "body2", "right_image_url", "right_image_link"]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
  });

  it("reads the second column back out", async () => {
    h.query.mockImplementation(answerBySql([[/FROM marketing_email_template/, { rows: [{ headline: "One", headline2: "Two", body2: "Second body", right_image_url: "https://img/r.png", right_image_link: "https://x/r" }] }]]));
    const r = await request(app).get("/api/marketing/email/template");
    expect(r.status).toBe(200);
    expect(r.body.data.template).toMatchObject({ headline: "One", headline2: "Two", body2: "Second body", rightImageUrl: "https://img/r.png", rightImageLink: "https://x/r" });
    // A one-column template reloads as one column.
    h.query.mockImplementation(answerBySql([[/FROM marketing_email_template/, { rows: [{ headline: "One" }] }]]));
    expect((await request(app).get("/api/marketing/email/template")).body.data.template).toMatchObject({ headline2: "", rightImageUrl: "" });
  });

  it("writes the second column on save", async () => {
    h.query.mockImplementation(answerBySql([]));
    const r = await request(app).post("/api/marketing/email/template").send({ headline: "One", secondHeadline: "Two", rightBody: "Second body", column2ImageUrl: "https://img/r.png", rightImageLink: "https://x/r" });
    expect(r.status).toBe(200);
    const [save] = callsMatching(h.query, "INSERT INTO marketing_email_template");
    const sql = sqlText(save![0]);
    const params = save![1] as unknown[];
    // $10..$13 are the second column, written on insert and on update.
    expect(sql).toContain("right_image_url=$12, right_image_link=$13");
    expect(params.slice(9, 13)).toEqual(["Two", "Second body", "https://img/r.png", "https://x/r"]);
    h.query.mockClear();
    await request(app).post("/api/marketing/email/template").send({ headline: "One" });
    expect((callsMatching(h.query, "INSERT INTO marketing_email_template")[0]![1] as unknown[]).slice(9, 13)).toEqual(["", "", "", ""]);
  });
});
