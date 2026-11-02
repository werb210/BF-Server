// BF_SERVER_v869_SETTINGS_PACK_NPS - the post-funding survey and review request.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});

import { categoryOf, normalizeNps, npsScore, queueFundedDeals, recordAnswer, saveNps, sendDueSurveys, surveyEmail, tokenHash } from "../nps.js";

const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADMIN = "11111111-1111-4111-8111-111111111111";
let stored: unknown;
let contact: Record<string, unknown>;
let audits: unknown[];
function fake(extra: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([
    ...extra,
    [/FROM users\s+WHERE id = \$1|FROM users WHERE id/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0], role: "Admin", active: true, status: "ACTIVE", token_version: 0, disabled: false }] })],
    [/FROM boreal_settings WHERE key = \$1/, () => ({ rows: stored ? [{ value: stored }] : [] })],
    [/INSERT INTO boreal_settings/, (_s: string, p?: unknown[]) => { stored = JSON.parse(String(p?.[1])); return { rows: [] }; }],
    [/UPDATE nps_surveys SET status = 'sending'/, { rows: [{ id: "s1", contact_id: CONTACT, application_id: "app-1" }] }],
    [/FROM contacts WHERE id::text = \$1/, () => ({ rows: [contact] })],
    [/FROM nps_surveys WHERE token_hash = \$1/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === tokenHash("t".repeat(32)) ? [{ id: "s1", contact_id: CONTACT, application_id: "app-1", status: "sent", score: null }] : [] })],
    [/insert into audit_events/i, (_s: string, p?: unknown[]) => { audits.push(p?.[4]); return { rows: [] }; }],
  ]));
}
beforeEach(() => {
  h.query.mockReset(); stored = null; audits = [];
  contact = { first_name: "Pat", email: "pat@x.test", phone: "+14035550100", email_out: false, sms_out: false, sms_consent: true };
  fake();
});

describe("the survey rules", () => {
  it("scores NPS as promoters minus detractors", () => {
    expect(npsScore([10, 9, 8, 7, 3])).toBe(20);
    expect(npsScore([])).toBeNull();
    expect([categoryOf(10), categoryOf(8), categoryOf(6)]).toEqual(["promoter", "passive", "detractor"]);
  });

  it("only surveys deals funded after it was switched on", async () => {
    const s = await saveNps({ query: h.query } as any, { enabled: true, delay_days: 3, review_url: "https://g.page/r/acme/review" }, ADMIN);
    expect(s.enabled_since).toBeTruthy();
    await queueFundedDeals({ query: h.query } as any, s);
    const [sql, p] = callsMatching(h.query, /INSERT INTO nps_surveys/)[0]!;
    expect(String(sql)).toContain("a.funded_at >= $1::timestamptz");
    expect(p).toEqual([s.enabled_since, 3]);
    // Saving again keeps the original start, so later edits never pull in older deals.
    const again = await saveNps({ query: h.query } as any, { ...s, delay_days: 5 }, ADMIN);
    expect(again.enabled_since).toBe(s.enabled_since);
  });

  it("the email offers 0-10 in one tap and never holds a phone number of ours", () => {
    const m = surveyEmail(normalizeNps({}), "Pat", "tok_abcdefghijklmnopqrstu");
    expect(m.html.match(/\?score=\d+/g)).toHaveLength(11);
    expect(m.text).toContain("/survey/tok_abcdefghijklmnopqrstu");
    expect(m.html + m.text).not.toMatch(/587.?888.?1837/);
  });
});

describe("sending", () => {
  const deps = () => ({ email: vi.fn(async () => ({ ok: true })), sms: vi.fn(async () => ({ ok: true })) });
  const on = normalizeNps({ enabled: true, enabled_since: "2026-10-01T00:00:00Z" });

  it("emails, and texts only with consent; logs it on the timeline", async () => {
    const d = deps();
    expect(await sendDueSurveys({ query: h.query } as any, on, d)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(d.email).toHaveBeenCalledTimes(1);
    expect(d.sms.mock.calls[0]![1]).toMatch(/Reply STOP to opt out\.$/);
    expect(callsMatching(h.query, /UPDATE nps_surveys SET status = 'sent'/)[0]![1]![2]).toEqual(["email", "sms"]);
    expect(callsMatching(h.query, /'nps_survey_sent'/)).toHaveLength(1);
  });

  it("respects opt-outs and missing consent; with no channel left the survey is skipped", async () => {
    contact = { ...contact, sms_consent: null, email_out: true };
    const d = deps();
    expect(await sendDueSurveys({ query: h.query } as any, on, d)).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(d.email).not.toHaveBeenCalled();
    expect(d.sms).not.toHaveBeenCalled();
  });

  it("sends nothing while switched off", async () => {
    const d = deps();
    expect(await sendDueSurveys({ query: h.query } as any, normalizeNps({ enabled: false }), d)).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(callsMatching(h.query, /UPDATE nps_surveys/)).toHaveLength(0);
  });
});

describe("answers", () => {
  const TOKEN = "t".repeat(32);
  it("a 9 or 10 gets the review link; the answer goes on the contact's timeline", async () => {
    const s = normalizeNps({ enabled: true, review_url: "https://g.page/r/acme/review" });
    expect(await recordAnswer({ query: h.query } as any, s, TOKEN, 10, "Great")).toEqual({ ok: true, review_url: "https://g.page/r/acme/review" });
    expect(await recordAnswer({ query: h.query } as any, s, TOKEN, 6, null)).toEqual({ ok: true, review_url: null });
    const tl = callsMatching(h.query, /'nps_response'/);
    expect(JSON.parse(String(tl[0]![1]![2]))).toEqual({ score: 10, comment: "Great", category: "promoter" });
    expect(await recordAnswer({ query: h.query } as any, s, TOKEN, 11, null)).toMatchObject({ ok: false, status: 400 });
    expect(await recordAnswer({ query: h.query } as any, s, "x".repeat(32), 5, null)).toMatchObject({ ok: false, status: 404 });
  });

  it("the public page and the plan-gated Admin settings", async () => {
    const router = (await import("../../routes/surveys.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/surveys", router);
    const page = await request(a).get(`/api/surveys/r/${TOKEN}`);
    expect(page.body).toMatchObject({ ok: true, answered: false });
    expect(page.body.question).toContain("recommend");
    const ans = await request(a).post(`/api/surveys/r/${TOKEN}`).send({ score: 9, comment: "Fast" });
    expect(ans.body).toEqual({ ok: true, review_url: null });
    const tok = jwt.sign({ sub: ADMIN, id: ADMIN, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
    const settings = await request(a).put("/api/surveys/settings").set("Authorization", `Bearer ${tok}`).send({ settings: { enabled: true, review_url: "not a url" } });
    expect(settings.status).toBe(400); // Boreal has no plans: a bad review link is refused, nothing is upsold
  });
});
