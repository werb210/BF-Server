// BF_SERVER_SMS_CASCADE_COMPLETE_v12
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { SMS_ELIGIBLE_SQL, EMAIL_FALLBACK_ELIGIBLE_SQL, CAMPAIGN_ELIGIBLE_SQL } from "../services/smsConsent.js";

const { queryMock, sendOne, sendMarketingSms } = vi.hoisted(() => ({ queryMock: vi.fn(), sendOne: vi.fn(), sendMarketingSms: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendOne };
});
vi.mock("../services/marketingSms.js", async (orig) => {
  const real: any = await orig();
  return { ...real, smsMarketingConfigured: () => true, sendMarketingSms, lookupLineType: async () => "mobile" };
});

import { countSmsRecipients, runSmsSend } from "../services/marketingSendRunner.js";
import { tickSequences } from "../services/sequenceEngine.js";
import marketing from "../routes/marketing.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

const AUDIENCE = /FROM contacts c\s+(LEFT JOIN companies co ON co\.id = c\.company_id\s+)?WHERE c\.silo = \$1/;
const audienceSql = (pool: { query: { mock: { calls: unknown[][] } } }) => String(callsMatching(pool.query, AUDIENCE)[0][0]);
const fakePool = (rows: unknown[] = []) => ({
  query: vi.fn(answerBySql([
    [/INSERT INTO sms_campaigns/, { rows: [{ id: "camp-1" }] }],
    [/INSERT INTO sms_campaign_sends \(campaign_id, contact_id, silo, phone\)/, { rows: [{ id: "send-1" }] }],
    [AUDIENCE, { rows }],
  ])),
});
const job = (fbHtml: string | null) => ({ silo: "BF", tag: "vip", body: "Hi", linkUrl: null, fbSubject: "Following up", fbHtml, createdBy: null });

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
  sendMarketingSms.mockReset();
  sendMarketingSms.mockResolvedValue({ ok: true, sid: "SM1" });
});

describe("sms cascade completeness", () => {
  it("campaign eligibility is the union of both channels", () => {
    expect(CAMPAIGN_ELIGIBLE_SQL).toContain(SMS_ELIGIBLE_SQL.trim());
    expect(CAMPAIGN_ELIGIBLE_SQL).toContain(EMAIL_FALLBACK_ELIGIBLE_SQL);
    // A contact with no phone is unreachable by SMS but reachable by email.
    expect(SMS_ELIGIBLE_SQL).toContain("COALESCE(c.phone,'') <> ''");
    expect(EMAIL_FALLBACK_ELIGIBLE_SQL).not.toContain("c.phone");
  });

  it("email fallback still honours the marketing opt-out", () => {
    expect(EMAIL_FALLBACK_ELIGIBLE_SQL).toContain("COALESCE(c.marketing_opt_out, false) = false");
  });

  it("the send widens its audience only when a fallback email exists", async () => {
    const withFb = fakePool();
    await runSmsSend(withFb as any, job("<p>fb</p>"));
    expect(audienceSql(withFb)).toContain(CAMPAIGN_ELIGIBLE_SQL);
    const without = fakePool();
    await runSmsSend(without as any, job(null));
    expect(audienceSql(without)).not.toContain(CAMPAIGN_ELIGIBLE_SQL);
    expect(audienceSql(without)).toContain(`AND ${SMS_ELIGIBLE_SQL}`);
  });

  it("the count widens on the same condition (default off), so the number matches the send", async () => {
    const off = fakePool();
    await countSmsRecipients(off as any, "BF", "vip");
    expect(audienceSql(off)).not.toContain(CAMPAIGN_ELIGIBLE_SQL);
    const on = fakePool([{ id: "e", email: "e@x.test", phone: null, name: null, company: null, sms_ok: false, marketing_opt_out: false, line_type: null }]);
    expect(await countSmsRecipients(on as any, "BF", "vip", null, null, true)).toBe(1);
    expect(audienceSql(on)).toContain(CAMPAIGN_ELIGIBLE_SQL);

    // The portal passes the fallback flag through on send and on the live count.
    await request(app).post("/api/marketing/sms/send").set("Authorization", `Bearer ${token}`).send({ body: "Hi", tags: ["vip"], fallbackHtml: "<p>fb</p>" });
    expect(String(callsMatching(queryMock, AUDIENCE)[0][0])).toContain(CAMPAIGN_ELIGIBLE_SQL);
    queryMock.mockClear();
    await request(app).get("/api/marketing/sms/audience-count?include=vip").set("Authorization", `Bearer ${token}`);
    expect(String(callsMatching(queryMock, AUDIENCE)[0][0])).not.toContain(CAMPAIGN_ELIGIBLE_SQL);
    queryMock.mockClear();
    await request(app).get("/api/marketing/sms/audience-count?include=vip&fallback=1").set("Authorization", `Bearer ${token}`);
    expect(String(callsMatching(queryMock, AUDIENCE)[0][0])).toContain(CAMPAIGN_ELIGIBLE_SQL);
  });

  it("a failed SMS send now cascades to email", async () => {
    sendMarketingSms.mockResolvedValue({ ok: false, error: "carrier rejected" });
    const pool = fakePool([{ id: "c1", email: "ann@x.test", phone: "+14035550101", name: "Ann", company: null, sms_ok: true, marketing_opt_out: false, line_type: "mobile" }]);
    const out = await runSmsSend(pool as any, job("<p>Hello {{first_name}}</p>"));
    // A cascaded contact is not also counted as a failure.
    expect(out).toMatchObject({ smsSent: 0, emailSent: 1, failed: 0 });
    expect(sendOne.mock.calls[0][0]).toMatchObject({ to: "ann@x.test", html: "<p>Hello Ann</p>" });
    // The dead send row must go, or the 36h worker chases a message never sent.
    expect(callsMatching(pool.query, /DELETE FROM sms_campaign_sends WHERE id = \$1/)[0][1]).toEqual(["send-1"]);
    const timeline = callsMatching(pool.query, /INSERT INTO crm_timeline_events/).map((c) => (c[1] as unknown[]));
    expect(timeline.map((p) => [p[1], JSON.parse(String(p[2])).reason])).toEqual([["email_cascade_sent", "sms_send_failed"]]);
  });

  it("a failed SMS with no fallback email is a failure", async () => {
    sendMarketingSms.mockResolvedValue({ ok: false, error: "carrier rejected" });
    const pool = fakePool([{ id: "c1", email: "ann@x.test", phone: "+14035550101", name: "Ann", company: null, sms_ok: true, marketing_opt_out: false, line_type: "mobile" }]);
    const out = await runSmsSend(pool as any, job(null));
    expect(out).toMatchObject({ smsSent: 0, emailSent: 0, failed: 1 });
    expect(sendOne).not.toHaveBeenCalled();
  });

  describe("an explicit sms sequence step falls back rather than vanishing", () => {
    const EN = { id: "enr-1", sequence_id: "seq-1", contact_id: "c-1", current_step: 0, enrolled_at: "2026-10-01", last_step_at: null, stop_on_reply: false, quiet_start: 0, quiet_end: 24 };
    const smsStep = (o: Record<string, unknown> = {}) => ({ channel: "sms", wait_minutes: 0, condition: "always", subject: "Following up", body: "Hi {{first_name}}", html: null, link_url: null, template_id: null, ...o });
    const notTextable = { id: "c-1", silo: "BF", email: "ann@x.test", phone: null, name: "Ann", sms_opt_out: false, marketing_opt_out: false, sms_consent: false, consent_basis: null, consent_at: null, line_type: null, company: null };
    async function tick(step: Record<string, unknown>, contact: Record<string, unknown>) {
      let claimed = false;
      const pool = {
        query: vi.fn(answerBySql([
          [/UPDATE marketing_sequence_enrollments SET status='running'/, () => (claimed ? { rows: [] } : ((claimed = true), { rows: [EN] }))],
          [/FROM marketing_sequence_steps WHERE sequence_id=\$1 ORDER BY/, { rows: [step] }],
          [/FROM contacts WHERE id=\$1/, { rows: [contact] }],
          [/INSERT INTO sequence_sends/, { rows: [{ id: "ss-1" }] }],
        ])),
      };
      await tickSequences(pool as any);
      return pool;
    }

    it("emails a contact who cannot be texted when the step has content", async () => {
      await tick(smsStep(), notTextable);
      expect(sendMarketingSms).not.toHaveBeenCalled();
      expect(sendOne).toHaveBeenCalledTimes(1);
      expect(sendOne.mock.calls[0][0]).toMatchObject({ to: "ann@x.test", subject: "Following up" });
    });

    it("only when there is something to say", async () => {
      await tick(smsStep({ subject: null, body: null }), notTextable);
      expect(sendOne).not.toHaveBeenCalled();
    });

    it("never to someone who opted out of marketing, or who has no email", async () => {
      await tick(smsStep(), { ...notTextable, marketing_opt_out: true });
      await tick(smsStep(), { ...notTextable, email: null });
      expect(sendOne).not.toHaveBeenCalled();
    });
  });

  describe("tracked links read an env name that is actually deployed", () => {
    const keys = ["PUBLIC_SERVER_URL", "PUBLIC_BASE_URL", "SERVER_URL"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    afterEach(() => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      vi.resetModules();
    });
    async function linkWith(env: Partial<Record<(typeof keys)[number], string>>) {
      for (const k of keys) delete process.env[k];
      Object.assign(process.env, env);
      vi.resetModules();
      // The real module (the file-level mock wraps it), loaded fresh so it reads this env.
      const { trackedLink } = await vi.importActual<typeof import("../services/marketingSms.js")>("../services/marketingSms.js");
      return trackedLink("send-1", "https://boreal.financial/apply");
    }

    it("uses PUBLIC_BASE_URL", async () => {
      expect(await linkWith({ PUBLIC_BASE_URL: "https://pub.example.test/" })).toMatch(/^https:\/\/pub\.example\.test\/api\/r\//);
    });
    it("uses SERVER_URL", async () => {
      expect(await linkWith({ SERVER_URL: "https://srv.example.test" })).toMatch(/^https:\/\/srv\.example\.test\/api\/r\//);
    });
  });
});
