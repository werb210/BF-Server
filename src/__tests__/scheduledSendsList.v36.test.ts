// BF_SERVER_SEND_JOBS_SUBJECT_v36 + BF_SERVER_CANCEL_REASON_v36
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});

import marketing from "../routes/marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const get = (url: string, silo = "BF") => request(app).get(url).set("Authorization", `Bearer ${token}`).set("X-Silo", silo);
const post = (url: string, silo = "BF") => request(app).post(url).set("Authorization", `Bearer ${token}`).set("X-Silo", silo);

const JOB_ROW = {
  id: "job-1", channel: "email", tag: null, status: "queued", total: 40, sent: 0, failed: 0, error: null,
  created_at: "2026-10-01T00:00:00Z", started_at: null, finished_at: null, not_before: "2026-10-01T00:05:00Z",
  cancel_requested: false, subject: "October news", template_id: "tpl-9",
};
const JOB_READ = /FROM marketing_send_jobs WHERE/;
const selected = (sql: string) => sql.replace(/\s+/g, " ");

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[/SELECT id, channel, tag, status/, { rows: [JOB_ROW], rowCount: 1 }]]));
});

describe("scheduled sends list exposes the campaign name", () => {
  it("the list selects the subject and template id out of the payload, silo scoped", async () => {
    const r = await get("/api/marketing/send-jobs", "BI");
    expect(r.status).toBe(200);
    expect(r.body.data.jobs[0]).toMatchObject({ subject: "October news", template_id: "tpl-9" });
    const [sql, params] = callsMatching(queryMock, JOB_READ)[0] as [string, unknown[]];
    expect(selected(sql)).toContain("payload->>'subject' AS subject, payload->>'templateId' AS template_id");
    expect(params).toEqual(["BI"]);
  });

  it("the single-job read selects the same columns, scoped to id and silo", async () => {
    const r = await get("/api/marketing/send-jobs/job-1");
    expect(r.body.data).toMatchObject({ id: "job-1", subject: "October news", template_id: "tpl-9" });
    const [sql, params] = callsMatching(queryMock, JOB_READ)[0] as [string, unknown[]];
    expect(selected(sql)).toContain("payload->>'subject' AS subject, payload->>'templateId' AS template_id");
    expect(params).toEqual(["job-1", "BF"]);
  });

  it("both reads still report the hold window and the kill switch flag", async () => {
    await get("/api/marketing/send-jobs");
    await get("/api/marketing/send-jobs/job-1");
    const reads = callsMatching(queryMock, JOB_READ);
    expect(reads).toHaveLength(2);
    for (const [sql] of reads) {
      expect(selected(String(sql))).toContain("finished_at, not_before, cancel_requested, payload->>'subject'");
    }
  });

  it("an unknown job reads as not found", async () => {
    queryMock.mockImplementation(answerBySql([]));
    const r = await get("/api/marketing/send-jobs/nope");
    expect(r.body.data).toEqual({ error: "not found" });
  });
});

describe("cancel explains itself when it cannot cancel", () => {
  it("reports the terminal status of a job that already finished", async () => {
    queryMock.mockImplementation(answerBySql([[/SELECT status FROM marketing_send_jobs WHERE id = \$1 AND silo = \$2/, { rows: [{ status: "done" }] }]]));
    const r = await post("/api/marketing/send-jobs/job-1/cancel", "BI");
    expect(r.body.data).toEqual({ canceled: false, status: "done", reason: "already finished" });
    expect(callsMatching(queryMock, /SELECT status FROM marketing_send_jobs/)[0][1]).toEqual(["job-1", "BI"]);
  });

  it("says not found when there is no such job in this silo", async () => {
    queryMock.mockImplementation(answerBySql([]));
    const r = await post("/api/marketing/send-jobs/ghost/cancel");
    expect(r.body.data).toEqual({ canceled: false, status: null, reason: "not found" });
  });
});
