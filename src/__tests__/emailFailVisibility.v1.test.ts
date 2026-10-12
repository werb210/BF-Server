// BF_SERVER_EMAIL_FAIL_VISIBILITY_v1 - a missing SendGrid configuration and a SendGrid
// rejection are reported, not swallowed; queued rejects are persisted on the job and
// stale running jobs are reclaimed.
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, sendOne, sg } = vi.hoisted(() => ({ queryMock: vi.fn(), sendOne: vi.fn(), sg: { configured: false } }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendgridConfigured: () => sg.configured, sendOne };
});

import marketing from "../routes/marketing.js";
import { runEmailSend } from "../services/marketingSendRunner.js";
import { startSendQueueWorker } from "../workers/sendQueueWorker.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const RECIPIENTS = /FROM contacts c LEFT JOIN companies co/;
const DEDUPE = /FROM crm_timeline_events/;
const two = { rows: [{ id: "c1", email: "a@x.test", name: "A", company: null }, { id: "c2", email: "b@x.test", name: "B", company: null }] };

beforeEach(() => {
  sg.configured = false;
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  sendOne.mockReset();
});

describe("BF_SERVER_EMAIL_FAIL_VISIBILITY_v1", () => {
  it.each(["/api/marketing/email/send", "/api/marketing/email/send-template"])("%s says SendGrid is not configured and sends nothing", async (url) => {
    const r = await request(app).post(url).set("Authorization", `Bearer ${token}`).send({ subject: "S", html: "<p>x</p>", tags: ["vip"] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ configured: false, error: "sendgrid_not_configured" });
    expect(sendOne).not.toHaveBeenCalled();
    expect(callsMatching(queryMock, /marketing_send_jobs/)).toHaveLength(0);
  });

  it("the runner reports the first SendGrid rejection instead of swallowing it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    sendOne.mockResolvedValueOnce({ ok: false, status: 403, error: "sender not verified" }).mockResolvedValueOnce({ ok: false, status: 429, error: "rate" });
    const pool = { query: vi.fn(answerBySql([[RECIPIENTS, two]])) };
    const out = await runEmailSend(pool as any, { silo: "BF", tag: "vip", subject: "S", html: "<p>x</p>" });
    expect(out).toMatchObject({ total: 2, sent: 0, failed: 2, rejectStatus: 403, rejectError: "sender not verified" });
    err.mockRestore();
  });

  it("the runner reports a thrown send as a reject reason too", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    sendOne.mockRejectedValue(new Error("socket hang up"));
    const pool = { query: vi.fn(answerBySql([[RECIPIENTS, two]])) };
    const out = await runEmailSend(pool as any, { silo: "BF", tag: "vip", subject: "S", html: "<p>x</p>" });
    expect(out).toMatchObject({ failed: 2, rejectError: "socket hang up" });
    err.mockRestore();
  });

  it("the 24h dedupe matches on the subject, so a resumed job does not double-send", async () => {
    sendOne.mockResolvedValue({ ok: true, status: 202 });
    const pool = {
      query: vi.fn(answerBySql([
        [RECIPIENTS, two],
        [DEDUPE, (_s: string, p?: unknown[]) => (p?.[0] === "c1" ? { rows: [{ id: "ev" }] } : { rows: [] })],
      ])),
    };
    const out = await runEmailSend(pool as any, { silo: "BF", tag: "vip", subject: "October", html: "<p>x</p>" });
    expect(out).toMatchObject({ total: 1, sent: 1 });
    expect(sendOne.mock.calls.map((c) => c[0].to)).toEqual(["b@x.test"]);
    const [sql, params] = callsMatching(pool.query, DEDUPE)[0] as [string, unknown[]];
    expect(sql).toContain("created_at > now() - interval '24 hours'");
    expect(sql).toContain("payload->>'subject' = $2");
    expect(params).toEqual(["c1", "October"]);
  });

  it("the worker persists a queued reject on the job and reclaims stale running jobs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    sendOne.mockResolvedValue({ ok: false, status: 401, error: "bad key" });
    const pool = {
      query: vi.fn(answerBySql([
        [/UPDATE marketing_send_jobs SET status='running'/, { rows: [{ id: "job-1", channel: "email", silo: "BF", tag: "vip", created_by: null, payload: { subject: "S", html: "<p>x</p>" } }] }],
        [RECIPIENTS, two],
      ])),
    };
    const w = startSendQueueWorker(pool as any);
    await vi.waitFor(() => expect(callsMatching(pool.query, /SET status=\$6/)).toHaveLength(1));
    w.stop();
    const claim = String(callsMatching(pool.query, /UPDATE marketing_send_jobs SET status='running'/)[0][0]);
    expect(claim).toContain("status='running' AND updated_at < now() - interval '10 minutes'");
    const fin = callsMatching(pool.query, /SET status=\$6/)[0][1] as unknown[];
    expect(fin).toEqual(["job-1", 2, 0, 2, "rejected (status 401): bad key", "done"]);
    err.mockRestore();
  });
});
