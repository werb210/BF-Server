// BF_SERVER_SMS_AUDIENCES_v726
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, sendMarketingSms } = vi.hoisted(() => ({ queryMock: vi.fn(), sendMarketingSms: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/marketingSms.js", async (orig) => {
  const real: any = await orig();
  return { ...real, smsMarketingConfigured: () => true, sendMarketingSms };
});

import { SMS_AUDIENCES, SMS_AUDIENCE_SQL, countSmsRecipients, runSmsSend } from "../services/marketingSendRunner.js";
import marketing from "../routes/marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const AUDIENCE = /FROM contacts c\s+(LEFT JOIN companies co ON co\.id = c\.company_id\s+)?WHERE c\.silo = \$1/;
const TEXTABLE = { id: "a", email: null, phone: "+14035550101", name: "N", company: null, sms_ok: true, marketing_opt_out: false, line_type: "mobile" };

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  sendMarketingSms.mockReset();
  sendMarketingSms.mockResolvedValue({ ok: true, sid: "SM1" });
});

describe("SMS audiences", () => {
  it("has the two audiences no tag can express", () => {
    expect(SMS_AUDIENCES.map((a) => a.label)).toEqual(["Started, not submitted", "CBF past applicants"]);
  });

  it("started-not-submitted excludes anyone with a submitted application; CBF uses the consent source", () => {
    expect(SMS_AUDIENCE_SQL).toContain("'application_started' = ANY(c.tags)");
    expect(SMS_AUDIENCE_SQL).toContain("WHERE sa.submitted_at IS NOT NULL");
    expect(SMS_AUDIENCE_SQL).toContain("c.consent_source = 'CBF application terms'");
    expect(SMS_AUDIENCE_SQL).toContain("left($2, 6) <> '__aud:' AND $2 = ANY(c.tags)");
  });

  it("the SMS screen lists them", async () => {
    const r = await request(app).get("/api/marketing/sms/segments").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data.audiences).toEqual(SMS_AUDIENCES);
  });

  it("the count and the send both filter through it, so consent, one-per-phone and the hold still apply", async () => {
    const rules = [
      [/INSERT INTO sms_campaigns/, { rows: [{ id: "camp-1" }] }],
      [/INSERT INTO sms_campaign_sends/, { rows: [{ id: "send-1" }] }],
      [AUDIENCE, { rows: [TEXTABLE, { ...TEXTABLE, id: "b" }] }],
    ] as Parameters<typeof answerBySql>[0];
    const countPool = { query: vi.fn(answerBySql(rules)) };
    const sendPool = { query: vi.fn(answerBySql(rules)) };
    expect(await countSmsRecipients(countPool as any, "BF", "__aud:started_not_submitted")).toBe(1);
    const out = await runSmsSend(sendPool as any, { silo: "BF", tag: "__aud:cbf_applicants", body: "Hi", linkUrl: null, fbSubject: null, fbHtml: null, createdBy: null });
    expect(out.smsSent).toBe(1);
    for (const [pool, tag] of [[countPool, "__aud:started_not_submitted"], [sendPool, "__aud:cbf_applicants"]] as const) {
      const [sql, params] = callsMatching(pool.query, AUDIENCE)[0] as [string, unknown[]];
      expect(sql).toContain(SMS_AUDIENCE_SQL);
      expect(params[1]).toBe(tag);
    }
  });

  it("an audience flows through the portal queue unchanged, held like any blast", async () => {
    queryMock.mockImplementation(answerBySql([
      [AUDIENCE, { rows: [TEXTABLE] }],
      [/INSERT INTO marketing_send_jobs/, { rows: [{ id: "job-1", not_before: "2026-10-12T00:05:00Z" }] }],
    ]));
    const r = await request(app).post("/api/marketing/sms/send").set("Authorization", `Bearer ${token}`).send({ body: "Hi", tag: "__aud:started_not_submitted" });
    expect(r.body.data).toMatchObject({ queued: true, holdMinutes: 5 });
    expect((callsMatching(queryMock, /INSERT INTO marketing_send_jobs/)[0][1] as unknown[])[1]).toBe("__aud:started_not_submitted");
    expect(sendMarketingSms).not.toHaveBeenCalled();
  });
});
