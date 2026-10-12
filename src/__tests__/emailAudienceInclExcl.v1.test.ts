// BF_SERVER_EMAIL_AUDIENCE_INCL_EXCL_v1 - branded email audience: include = ANY-of
// tags via array overlap; exclude removes ANY-of and wins over include; big blasts
// carry the arrays through the queue payload so the worker applies the same filter.
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, sendOne } = vi.hoisted(() => ({ queryMock: vi.fn(), sendOne: vi.fn() }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendgridConfigured: () => true, sendOne };
});
vi.mock("../services/landingPage.service.js", async (orig) => {
  const real: any = await orig();
  return { ...real, createLandingPageFromHtml: async () => ({ slug: "s", url: "https://x.test/e/s" }) };
});

import marketing from "../routes/marketing.js";
import { countEmailRecipients, runEmailSend } from "../services/marketingSendRunner.js";
import { startSendQueueWorker } from "../workers/sendQueueWorker.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

const COUNT = /SELECT count\(\*\)::int AS n\s+FROM contacts c/;
const RECIPIENTS = /FROM contacts c LEFT JOIN companies co/;
const INSERT_JOB = /INSERT INTO marketing_send_jobs/;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [COUNT, { rows: [{ n: 7 }] }],
    [INSERT_JOB, { rows: [{ id: "job-1", not_before: "2026-10-12T00:05:00Z" }] }],
  ]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
});

describe("email audience include/exclude", () => {
  it("the count filters by array overlap for include and NOT-overlap for exclude", async () => {
    const pool = { query: vi.fn(answerBySql([[COUNT, { rows: [{ n: 4 }] }]])) };
    expect(await countEmailRecipients(pool as any, "BF", null, ["a", "b"], ["c"])).toBe(4);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["BF", null, ["a", "b"], ["c"]]);
    expect(sql).toContain("($3::text[] IS NULL OR COALESCE(c.tags,'{}') && $3)");
    expect(sql).toContain("($4::text[] IS NULL OR NOT (COALESCE(c.tags,'{}') && $4))");
  });

  it("the send applies the same include/exclude filter", async () => {
    const pool = { query: vi.fn(answerBySql([[RECIPIENTS, { rows: [{ id: "c1", email: "a@x.test", name: "A", company: null }] }]])) };
    await runEmailSend(pool as any, { silo: "BF", tag: null, subject: "S", html: "<p>x</p>", tags: ["a"], excludeTags: ["c"] });
    const [sql, params] = callsMatching(pool.query, RECIPIENTS)[0] as [string, unknown[]];
    expect(params).toEqual(["BF", null, ["a"], ["c"]]);
    expect(sql).toContain("COALESCE(c.tags,'{}') && $3");
    expect(sql).toContain("NOT (COALESCE(c.tags,'{}') && $4)");
    expect(sendOne).toHaveBeenCalledTimes(1);
  });

  it("send-template accepts tags/excludeTags, normalises them, counts with them and carries them on the queued job", async () => {
    const r = await auth(request(app).post("/api/marketing/email/send-template"))
      .send({ subject: "Hi", headline: "x", body: "y", tags: [" vip ", "vip", "", "new"], excludeTags: "dnc, staff" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ queued: true, total: 7 });
    expect(callsMatching(queryMock, COUNT)[0][1]).toEqual(["BF", null, ["vip", "new"], ["dnc", "staff"]]);
    const payload = JSON.parse(String((callsMatching(queryMock, INSERT_JOB)[0][1] as unknown[])[2]));
    expect(payload.tags).toEqual(["vip", "new"]);
    expect(payload.excludeTags).toEqual(["dnc", "staff"]);
  });

  it("exposes a live audience-count endpoint for the composer preview", async () => {
    const r = await auth(request(app).get("/api/marketing/email/audience-count?include=vip,new&exclude=dnc")).set("X-Silo", "BI");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ n: 7 });
    expect(callsMatching(queryMock, COUNT)[0][1]).toEqual(["BI", null, ["vip", "new"], ["dnc"]]);
  });

  it("the queue worker passes the arrays back into the runner", async () => {
    const pool = {
      query: vi.fn(answerBySql([
        [/UPDATE marketing_send_jobs SET status='running'/, { rows: [{ id: "job-1", channel: "email", silo: "BF", tag: null, created_by: null, payload: { subject: "S", html: "<p>x</p>", tags: ["vip"], excludeTags: ["dnc"] } }] }],
        [RECIPIENTS, { rows: [] }],
      ])),
    };
    const w = startSendQueueWorker(pool as any);
    await vi.waitFor(() => expect(callsMatching(pool.query, RECIPIENTS)).toHaveLength(1));
    w.stop();
    expect(callsMatching(pool.query, RECIPIENTS)[0][1]).toEqual(["BF", null, ["vip"], ["dnc"]]);
  });
});
