// BF_SERVER_SMS_SEND_SAFETY_v710
import { describe, expect, it, vi, beforeEach } from "vitest";
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
  return { ...real, smsMarketingConfigured: () => true, sendMarketingSms, lookupLineType: async () => "mobile" };
});

import { planSmsAudience, phone10, countSmsRecipients, runSmsSend, type SmsAudienceRow } from "../services/marketingSendRunner.js";
import { startSendQueueWorker } from "../workers/sendQueueWorker.js";
import marketing from "../routes/marketing.js";
import mayaStaff from "../routes/mayaStaff.js";

let n = 0;
const row = (o: Partial<SmsAudienceRow>): SmsAudienceRow => ({ id: "c" + (++n), email: null, phone: null, name: null, company: null, sms_ok: false, marketing_opt_out: false, line_type: null, ...o });

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
app.use("/api/maya", mayaStaff);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const AUDIENCE = /FROM contacts c\s+(LEFT JOIN companies co ON co\.id = c\.company_id\s+)?WHERE c\.silo = \$1\s+AND \(/;
const RECENT = /FROM sms_campaign_sends\s+WHERE message_sid IS NOT NULL/;
const INSERT_JOB = /INSERT INTO marketing_send_jobs/;
const TEXTABLE = (id: string, phone: string) => ({ id, email: null, phone, name: "N", company: null, sms_ok: true, marketing_opt_out: false, line_type: "mobile" });

describe("who a campaign texts", () => {
  it("texts only consented Canadian mobiles, never an email-only contact", () => {
    const rows = [row({ phone: "+14035550101", sms_ok: true }), row({ phone: "+14035550102", sms_ok: false, email: "b@x.com" }), row({ phone: "+12125550103", sms_ok: true, email: "c@x.com" }), row({ phone: "+14035550104", sms_ok: true, line_type: "landline" })];
    const plan = planSmsAudience(rows, true);
    expect(plan.text.map((r) => r.phone)).toEqual(["+14035550101"]);
    expect(plan.email.map((r) => r.email)).toEqual(["b@x.com", "c@x.com"]);
  });
  it("without a fallback email, people who cannot be texted get nothing", () => {
    const plan = planSmsAudience([row({ phone: "+14035550102", sms_ok: false, email: "b@x.com" })], false);
    expect(plan.text).toEqual([]); expect(plan.email).toEqual([]);
  });
  it("one text per phone number, however many contact records share it", () => {
    expect(planSmsAudience([row({ phone: "+1 (403) 555-0101", sms_ok: true }), row({ phone: "4035550101", sms_ok: true }), row({ phone: "+14035550101", sms_ok: true })], false).text).toHaveLength(1);
  });
  it("one fallback email per address", () => { expect(planSmsAudience([row({ email: "A@x.com" }), row({ email: "a@x.com " })], true).email).toHaveLength(1); });
  it("honours the marketing opt-out on both channels", () => {
    const plan = planSmsAudience([row({ phone: "+14035550101", sms_ok: true, marketing_opt_out: true, email: "a@x.com" })], true);
    expect(plan.text).toEqual([]); expect(plan.email).toEqual([]);
  });
  it("skips phones already texted (resumed job, or a text in the last 24 hours)", () => {
    const plan = planSmsAudience([row({ phone: "+14035550101", sms_ok: true }), row({ phone: "+14035550199", sms_ok: true })], false, new Set([phone10("+14035550101")]));
    expect(plan.text.map((r) => r.phone)).toEqual(["+14035550199"]);
  });
});

describe("send path wiring", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([]));
    sendMarketingSms.mockReset();
    sendMarketingSms.mockResolvedValue({ ok: true, sid: "SM1" });
  });

  it("the send and the count share one planner: duplicates and recent texts are dropped by both", async () => {
    const rules = [
      [RECENT, { rows: [{ p10: "4035550199" }] }],
      [/INSERT INTO sms_campaigns/, { rows: [{ id: "camp-1" }] }],
      [/INSERT INTO sms_campaign_sends/, { rows: [{ id: "send-1" }] }],
      [AUDIENCE, { rows: [TEXTABLE("a", "+14035550101"), TEXTABLE("b", "403-555-0101"), TEXTABLE("c", "+14035550199"), TEXTABLE("d", "+14035550102")] }],
    ] as Parameters<typeof answerBySql>[0];
    const countPool = { query: vi.fn(answerBySql(rules)) };
    const sendPool = { query: vi.fn(answerBySql(rules)) };
    const count = await countSmsRecipients(countPool as any, "BF", "vip");
    const sent = await runSmsSend(sendPool as any, { silo: "BF", tag: "vip", body: "Hi", linkUrl: null, fbSubject: null, fbHtml: null, createdBy: null });
    expect(count).toBe(2);
    expect(sent.smsSent).toBe(count);
    expect(sendMarketingSms.mock.calls.map((c) => c[0])).toEqual(["+14035550101", "+14035550102"]);
  });

  it("every portal SMS campaign is queued with the hold; none send inside the request", async () => {
    queryMock.mockImplementation(answerBySql([
      [AUDIENCE, { rows: [TEXTABLE("a", "+14035550101"), TEXTABLE("b", "+14035550102")] }],
      [INSERT_JOB, { rows: [{ id: "job-1", not_before: "2026-10-12T00:05:00Z" }] }],
    ]));
    const r = await request(app).post("/api/marketing/sms/send").set("Authorization", `Bearer ${token}`).send({ body: "Hello", tags: ["vip"], expectedCount: 2 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ queued: true, jobId: "job-1", total: 2, holdMinutes: 5 });
    expect(callsMatching(queryMock, INSERT_JOB)).toHaveLength(1);
    expect(callsMatching(queryMock, /INSERT INTO sms_campaigns/)).toHaveLength(0);
    expect(sendMarketingSms).not.toHaveBeenCalled();
  });

  it("refuses with audience_changed when the confirmed count no longer matches", async () => {
    queryMock.mockImplementation(answerBySql([[AUDIENCE, { rows: [TEXTABLE("a", "+14035550101"), TEXTABLE("b", "+14035550102")] }]]));
    const r = await request(app).post("/api/marketing/sms/send").set("Authorization", `Bearer ${token}`).send({ body: "Hello", tags: ["vip"], expectedCount: 5 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { code: "audience_changed" }, total: 2 });
    expect(callsMatching(queryMock, INSERT_JOB)).toHaveLength(0);
  });

  it("a double-click within a minute returns the job already queued", async () => {
    queryMock.mockImplementation(answerBySql([
      [AUDIENCE, { rows: [TEXTABLE("a", "+14035550101")] }],
      [/SELECT id, not_before, total FROM marketing_send_jobs/, { rows: [{ id: "job-0", not_before: "2026-10-12T00:05:00Z", total: 1 }] }],
    ]));
    const r = await request(app).post("/api/marketing/sms/send").set("Authorization", `Bearer ${token}`).send({ body: "Hello", tags: ["vip"] });
    expect(r.body.data).toMatchObject({ queued: true, jobId: "job-0", duplicate: true });
    expect(callsMatching(queryMock, INSERT_JOB)).toHaveLength(0);
  });

  it("Maya's confirmed SMS send is queued too", async () => {
    const svcSecret = process.env.AGENT_SERVICE_JWT_SECRET || process.env.JWT_SECRET!;
    const svc = jwt.sign({ kind: "service", source: "maya-service" }, svcSecret, { algorithm: "HS256", audience: "bf-server", expiresIn: "5m" });
    queryMock.mockImplementation(answerBySql([
      [/UPDATE maya_pending_actions/, { rows: [{ id: "pa-1" }] }],
      [AUDIENCE, { rows: [TEXTABLE("a", "+14035550101")] }],
      [INSERT_JOB, { rows: [{ id: "job-m", not_before: "2026-10-12T00:05:00Z" }] }],
    ]));
    const r = await request(app).post("/api/maya/staff/marketing-send").set("Authorization", `Bearer ${svc}`).send({
      channel: "sms", body: "Hello", tag: "vip", confirm: true,
      staff_user_id: "11111111-1111-4111-8111-111111111111", pending_action_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, queued: true, jobId: "job-m", recipients: 1 });
    const [sql, params] = callsMatching(queryMock, INSERT_JOB)[0] as [string, unknown[]];
    expect(sql).toContain("now() + interval '5 minutes'");
    expect(params.slice(0, 2)).toEqual(["BF", "vip"]);
    expect(sendMarketingSms).not.toHaveBeenCalled();
    expect(callsMatching(queryMock, /INSERT INTO sms_campaigns/)).toHaveLength(0);
  });

  it("the queue keeps the chosen tags and resumes its own campaign", async () => {
    const pool = {
      query: vi.fn(answerBySql([
        [/UPDATE marketing_send_jobs SET status='running'/, { rows: [{ id: "job-1", channel: "sms", silo: "BF", tag: null, created_by: null, payload: { body: "Hi", tags: ["vip"], excludeTags: ["dnc"], campaignId: "camp-7" } }] }],
        [/INSERT INTO sms_campaign_sends/, { rows: [{ id: "send-1" }] }],
        [AUDIENCE, { rows: [TEXTABLE("a", "+14035550101")] }],
      ])),
    };
    const w = startSendQueueWorker(pool as any);
    await vi.waitFor(() => expect(callsMatching(pool.query, /SET status=\$5/)).toHaveLength(1));
    w.stop();
    expect(callsMatching(pool.query, /INSERT INTO sms_campaigns/)).toHaveLength(0);
    expect(callsMatching(pool.query, /WHERE s\.campaign_id = \$1/)[0][1]).toEqual(["camp-7"]);
    expect(callsMatching(pool.query, AUDIENCE)[0][1]).toEqual(["BF", null, ["vip"], ["dnc"]]);
    expect((callsMatching(pool.query, /INSERT INTO sms_campaign_sends/)[0][1] as unknown[])[0]).toBe("camp-7");
  });
});
