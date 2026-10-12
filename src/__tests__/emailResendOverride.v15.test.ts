// BF_SERVER_EMAIL_TWO_COLUMN_ONLY_v15 - `resend` bypasses the 24h dedupe.
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
import { runEmailSend } from "../services/marketingSendRunner.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const DEDUPE = /FROM crm_timeline_events/;
const INSERT_JOB = /INSERT INTO marketing_send_jobs/;
// Every recipient was already sent this subject in the last 24 hours.
const sentBefore = () => ({
  query: vi.fn(answerBySql([
    [/FROM contacts c LEFT JOIN companies co/, { rows: [{ id: "c1", email: "a@x.test", name: "A", company: null }] }],
    [DEDUPE, { rows: [{ id: "ev-1" }] }],
  ])),
});

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/SELECT count\(\*\)::int AS n\s+FROM contacts c/, { rows: [{ n: 2 }] }],
    [INSERT_JOB, { rows: [{ id: "job-1", not_before: "2026-10-12T00:05:00Z" }] }],
  ]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
});

describe("resend override", () => {
  it("skips the 24h dedupe when asked", async () => {
    const pool = sentBefore();
    const out = await runEmailSend(pool as any, { silo: "BF", tag: "vip", subject: "S", html: "<p>x</p>", resend: true });
    expect(out).toMatchObject({ total: 1, sent: 1 });
    expect(callsMatching(pool.query, DEDUPE)).toHaveLength(0);
    expect(sendOne).toHaveBeenCalledTimes(1);
  });

  it("keeps the dedupe on by default - a resumed blast must not double-send", async () => {
    const pool = sentBefore();
    const out = await runEmailSend(pool as any, { silo: "BF", tag: "vip", subject: "S", html: "<p>x</p>" });
    expect(out).toMatchObject({ total: 0, sent: 0 });
    expect(sendOne).not.toHaveBeenCalled();
    expect(String(callsMatching(pool.query, DEDUPE)[0][0])).toContain("interval '24 hours'");
  });

  it.each([
    ["/api/marketing/email/send", { subject: "S", html: "<p>x</p>", tags: ["vip"] }],
    ["/api/marketing/email/send-template", { subject: "S", headline: "h", tags: ["vip"] }],
  ])("%s carries the flag onto the queued job so the worker honours it", async (url, body) => {
    for (const [resend, expected] of [[true, true], ["yes", false], [undefined, false]] as const) {
      queryMock.mockClear();
      const r = await request(app).post(url).set("Authorization", `Bearer ${token}`).send({ ...body, resend });
      expect(r.body.data.queued).toBe(true);
      const payload = JSON.parse(String((callsMatching(queryMock, INSERT_JOB)[0][1] as unknown[])[2]));
      expect(payload.resend).toBe(expected);
    }
  });
});
