// BF_SERVER_SEND_KILL_SWITCH_v1 + BF_SERVER_DEADLETTER_UNJAM_v1
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, sendOne, sendMarketingSms, slack } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendOne: vi.fn(),
  sendMarketingSms: vi.fn(),
  slack: vi.fn(),
}));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendgridConfigured: () => true, sendOne };
});
vi.mock("../services/marketingSms.js", async (orig) => {
  const real: any = await orig();
  return { ...real, smsMarketingConfigured: () => true, sendMarketingSms, lookupLineType: async () => "mobile" };
});
vi.mock("../observability/alerts.js", () => ({ sendSlackAlert: slack }));
vi.mock("../modules/notifications/sms.service.js", () => ({ sendSms: vi.fn() }));
vi.mock("../services/crmWebhook.js", () => ({ pushLeadToCRM: vi.fn() }));

import marketing from "../routes/marketing.js";
import { runEmailSend, runSmsSend } from "../services/marketingSendRunner.js";
import { startSendQueueWorker } from "../workers/sendQueueWorker.js";
import { processDeadLetters } from "../workers/deadLetterWorker.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

const emailRows = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, email: `p${i}@x.test`, name: `P ${i}`, company: null }));
const smsRows = Array.from({ length: 60 }, (_, i) => ({
  id: `s${i}`, email: null, phone: `+1403555${String(1000 + i)}`, name: null, company: null, sms_ok: true, marketing_opt_out: false, line_type: "mobile",
}));
const fakePool = (rules: Parameters<typeof answerBySql>[0]) => ({ query: vi.fn(answerBySql(rules)) });

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
  sendMarketingSms.mockReset();
  sendMarketingSms.mockResolvedValue({ ok: true, sid: "SM1" });
  slack.mockReset();
});

describe("send kill switch v1", () => {
  it("migration adds cancel_requested idempotently", () => {
    expect(read("migrations/2026_07_08_send_cancel_requested.sql")).toMatch(/ADD COLUMN IF NOT EXISTS cancel_requested/);
  });

  it("the email runner stops between batches when asked and reports aborted", async () => {
    const pool = fakePool([[/FROM contacts c LEFT JOIN companies co/, { rows: emailRows }]]);
    const abort = vi.fn(async () => true);
    const out = await runEmailSend(pool as any, { silo: "BF", tag: "vip", subject: "S", html: "<p>x</p>" }, undefined, abort);
    expect(out.aborted).toBe(true);
    expect(out.sent).toBe(50);
    expect(sendOne).toHaveBeenCalledTimes(50);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("the email runner keeps going when no cancel was requested", async () => {
    const pool = fakePool([[/FROM contacts c LEFT JOIN companies co/, { rows: emailRows }]]);
    const out = await runEmailSend(pool as any, { silo: "BF", tag: "vip", subject: "S", html: "<p>x</p>" }, undefined, async () => false);
    expect(out).toMatchObject({ aborted: false, sent: 60 });
  });

  it("the sms runner stops between batches when asked and reports aborted", async () => {
    const pool = fakePool([
      [/INSERT INTO sms_campaigns/, { rows: [{ id: "camp-1" }] }],
      [/INSERT INTO sms_campaign_sends/, { rows: [{ id: "send-x" }] }],
      [/FROM contacts c LEFT JOIN companies co/, { rows: smsRows }],
    ]);
    const out = await runSmsSend(pool as any, { silo: "BF", tag: "vip", body: "Hi", linkUrl: null, fbSubject: null, fbHtml: null, createdBy: null }, undefined, async () => true);
    expect(out.aborted).toBe(true);
    expect(out.smsSent).toBe(50);
    expect(sendMarketingSms).toHaveBeenCalledTimes(50);
  });

  it.each([[true, "canceled"], [false, "done"]])("the worker checks cancel_requested between batches (requested=%s) and marks the job %s", async (requested, status) => {
    const pool = fakePool([
      [/UPDATE marketing_send_jobs SET status='running'/, { rows: [{ id: "job-1", channel: "email", silo: "BF", tag: "vip", created_by: null, payload: { subject: "S", html: "<p>x</p>" } }] }],
      [/SELECT cancel_requested FROM marketing_send_jobs/, { rows: [{ cancel_requested: requested }] }],
      [/FROM contacts c LEFT JOIN companies co/, { rows: emailRows }],
    ]);
    const w = startSendQueueWorker(pool as any);
    await vi.waitFor(() => expect(callsMatching(pool.query, /SET status=\$6/)).toHaveLength(1));
    w.stop();
    const check = callsMatching(pool.query, /SELECT cancel_requested FROM marketing_send_jobs/);
    expect(check.length).toBeGreaterThanOrEqual(1);
    expect(check[0][1]).toEqual(["job-1"]);
    const fin = callsMatching(pool.query, /SET status=\$6/)[0][1] as unknown[];
    expect(fin[0]).toBe("job-1");
    expect(fin[5]).toBe(status);
    expect(fin[2]).toBe(requested ? 50 : 60);
  });

  it("the cancel route flags a running job with cancel_requested", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SET status='canceled'/, { rows: [], rowCount: 0 }],
      [/SET cancel_requested=true/, { rows: [{ id: "job-3" }], rowCount: 1 }],
    ]));
    const r = await request(app).post("/api/marketing/send-jobs/job-3/cancel").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ canceled: true, id: "job-3", phase: "stopping" });
    const [sql, params] = callsMatching(queryMock, /SET cancel_requested=true/)[0] as [string, unknown[]];
    expect(sql).toContain("status='running'");
    expect(params).toEqual(["job-3", "BF"]);
  });
});

describe("dead-letter unjam v1", () => {
  it("only pulls jobs under the retry cap, and prunes old abandoned ones", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT \* FROM failed_jobs/, { rows: [{ id: "j1", retry_count: 0, type: "slack_webhook", data: { message: "hi" } }] }],
    ]));
    await processDeadLetters();
    const [selectSql, selectParams] = callsMatching(queryMock, /SELECT \* FROM failed_jobs/)[0] as [string, unknown[]];
    expect(selectSql).toContain("WHERE retry_count < $1 ORDER BY created_at ASC");
    expect(selectParams).toEqual([10]);
    const prune = callsMatching(queryMock, /DELETE FROM failed_jobs WHERE retry_count >= \$1 AND created_at </);
    expect(prune).toHaveLength(1);
    expect(prune[0][1]).toEqual([10]);
    expect(slack).toHaveBeenCalledWith("hi");
    expect(callsMatching(queryMock, /DELETE FROM failed_jobs WHERE id = \$1/)[0][1]).toEqual(["j1"]);
  });
});
