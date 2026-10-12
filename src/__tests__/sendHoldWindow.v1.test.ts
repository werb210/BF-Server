// BF_SERVER_SEND_HOLD_WINDOW_v1 - every queued blast is held before the worker may
// send it, and staff can cancel it during the hold.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, runEmailSend, runSmsSend } = vi.hoisted(() => ({ queryMock: vi.fn(), runEmailSend: vi.fn(), runSmsSend: vi.fn() }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendgridConfigured: () => true, sendOne: async () => ({ ok: true, status: 202 }) };
});
vi.mock("../services/marketingSms.js", async (orig) => {
  const real: any = await orig();
  return { ...real, smsMarketingConfigured: () => true };
});
vi.mock("../services/landingPage.service.js", async (orig) => {
  const real: any = await orig();
  return { ...real, createLandingPageFromHtml: async () => ({ slug: "s", url: "https://x.test/e/s" }) };
});
vi.mock("../services/marketingSendRunner.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    countEmailRecipients: async () => 3,
    countSmsRecipients: async () => 2,
    runEmailSend: (...a: unknown[]) => runEmailSend(...a),
    runSmsSend: (...a: unknown[]) => runSmsSend(...a),
  };
});

import marketing from "../routes/marketing.js";
import { startSendQueueWorker } from "../workers/sendQueueWorker.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

const INSERT_JOB = /INSERT INTO marketing_send_jobs/;
const HOLD_CANCEL = /SET status='canceled'/;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [INSERT_JOB, (_s: string, p?: unknown[]) => ({ rows: [{ id: "job-1", not_before: (p as unknown[])[5] }], rowCount: 1 })],
  ]));
  runEmailSend.mockReset();
  runSmsSend.mockReset();
});

describe("send hold window v1", () => {
  it("migration adds not_before idempotently", () => {
    expect(read("migrations/2026_07_08_send_hold_window.sql")).toMatch(/ADD COLUMN IF NOT EXISTS not_before/);
  });

  it("the worker claims only queued jobs whose hold has expired", async () => {
    const pool = { query: vi.fn(answerBySql([])) };
    const w = startSendQueueWorker(pool as any);
    await vi.waitFor(() => expect(callsMatching(pool.query, /UPDATE marketing_send_jobs SET status='running'/)).toHaveLength(1));
    w.stop();
    const claim = String(callsMatching(pool.query, /UPDATE marketing_send_jobs SET status='running'/)[0][0]);
    expect(claim).toContain("status='queued' AND (not_before IS NULL OR not_before <= now())");
    // Nothing claimable means nothing is sent.
    expect(runEmailSend).not.toHaveBeenCalled();
    expect(runSmsSend).not.toHaveBeenCalled();
  });

  it.each([
    ["email blast", "/api/marketing/email/send", { subject: "Hi", html: "<p>x</p>", tags: ["vip"] }],
    ["branded email", "/api/marketing/email/send-template", { subject: "Hi", headline: "x", body: "y", tags: ["vip"] }],
    ["sms blast", "/api/marketing/sms/send", { body: "Hello", tags: ["vip"] }],
  ])("a queued %s is inserted with not_before at least the hold away and nothing sends in the request", async (_label, url, body) => {
    const before = Date.now();
    const r = await auth(request(app).post(url)).send(body);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ queued: true, jobId: "job-1", holdMinutes: 5 });
    const insert = callsMatching(queryMock, INSERT_JOB);
    expect(insert).toHaveLength(1);
    const notBefore = new Date(String((insert[0][1] as unknown[])[5])).getTime();
    expect(notBefore).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
    expect(notBefore).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1000);
    expect(runEmailSend).not.toHaveBeenCalled();
    expect(runSmsSend).not.toHaveBeenCalled();
  });

  it("a held job is canceled outright, only while queued and not started", async () => {
    queryMock.mockImplementation(answerBySql([[HOLD_CANCEL, { rows: [{ id: "job-7" }], rowCount: 1 }]]));
    const r = await auth(request(app).post("/api/marketing/send-jobs/job-7/cancel")).set("X-Silo", "BI");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ canceled: true, id: "job-7", phase: "held" });
    const [sql, params] = callsMatching(queryMock, HOLD_CANCEL)[0] as [string, unknown[]];
    expect(sql).toContain("status='queued' AND started_at IS NULL");
    expect(params).toEqual(["job-7", "BI"]);
  });
});
