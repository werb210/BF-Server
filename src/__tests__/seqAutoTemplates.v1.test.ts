// BF_SERVER_SEQ_AUTO_TEMPLATES_v1 - an auto step uses the template written for the
// branch (SMS or email) the contact actually takes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

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
  return { ...real, sendMarketingSms, lookupLineType: async () => "mobile" };
});

import { tickSequences } from "../services/sequenceEngine.js";
import marketing from "../routes/marketing.js";

const migration = readFileSync(join(process.cwd(), "migrations", "2026_07_30_seq_auto_channel_templates_v1.sql"), "utf-8");

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

const SMS_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMAIL_T = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SINGLE_T = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TEMPLATES: Record<string, Record<string, unknown>> = {
  [SMS_T]: { subject: null, body: "Text for {{first_name}}", html: null, link_url: null },
  [EMAIL_T]: { subject: "Email for {{first_name}}", body: null, html: "<p>Email body</p>", link_url: null },
  [SINGLE_T]: { subject: "Single subject", body: null, html: "<p>Single</p>", link_url: null },
};
const EN = { id: "enr-1", sequence_id: "seq-1", contact_id: "c-1", current_step: 0, enrolled_at: "2026-10-01", last_step_at: null, stop_on_reply: false, quiet_start: 0, quiet_end: 24 };
const TEXTABLE = { id: "c-1", silo: "BF", owner_id: null, email: "ann@x.test", phone: "+14035550101", name: "Ann Lee", sms_opt_out: false, marketing_opt_out: false, sms_consent: true, consent_basis: "express", consent_at: null, line_type: "mobile", company: null };
const EMAIL_ONLY = { ...TEXTABLE, phone: null };
const step = (o: Record<string, unknown>) => ({ channel: "auto", wait_minutes: 0, condition: "always", subject: null, body: null, html: null, link_url: null, template_id: null, sms_template_id: SMS_T, email_template_id: EMAIL_T, assignee_user_id: null, task_type: null, task_priority: null, task_queue_id: null, task_pause: true, ...o });

async function runStep(s: Record<string, unknown>, contact: Record<string, unknown>) {
  let claimed = false;
  const pool = {
    query: vi.fn(answerBySql([
      [/UPDATE marketing_sequence_enrollments SET status='running'/, () => (claimed ? { rows: [] } : ((claimed = true), { rows: [EN] }))],
      [/FROM marketing_sequence_steps WHERE sequence_id=\$1 ORDER BY/, { rows: [s] }],
      [/FROM marketing_template WHERE id=\$1/, (_q: string, p?: unknown[]) => ({ rows: TEMPLATES[String(p?.[0])] ? [TEMPLATES[String(p?.[0])]] : [] })],
      [/FROM contacts WHERE id=\$1/, { rows: [contact] }],
      [/INSERT INTO sequence_sends/, { rows: [{ id: "ss-1" }] }],
    ])),
  };
  await tickSequences(pool as any);
  return { pool, templatesLoaded: callsMatching(pool.query, /FROM marketing_template WHERE id=\$1/).map((c) => (c[1] as unknown[])[0]) };
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[/INSERT INTO marketing_sequences/, { rows: [{ id: "seq-9" }] }]]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
  sendMarketingSms.mockReset();
  sendMarketingSms.mockResolvedValue({ ok: true, sid: "SM1" });
});

describe("an auto step uses the template written for the branch it takes", () => {
  it("a textable contact gets the SMS template, texted", async () => {
    const { templatesLoaded } = await runStep(step({}), TEXTABLE);
    expect(templatesLoaded).toEqual([SMS_T]);
    expect(sendOne).not.toHaveBeenCalled();
    expect(String(sendMarketingSms.mock.calls[0][1])).toMatch(/^Text for Ann /);
  });

  it("a contact who cannot be texted gets the email template, emailed", async () => {
    const { templatesLoaded } = await runStep(step({}), EMAIL_ONLY);
    expect(templatesLoaded).toEqual([EMAIL_T]);
    expect(sendMarketingSms).not.toHaveBeenCalled();
    expect(sendOne.mock.calls[0][0]).toMatchObject({ to: "ann@x.test", subject: "Email for Ann", html: "<p>Email body</p>" });
  });

  it("an auto step ignores template_id: resolution waits for the branch", async () => {
    const { templatesLoaded } = await runStep(step({ template_id: SINGLE_T }), EMAIL_ONLY);
    expect(templatesLoaded).toEqual([EMAIL_T]);
  });

  it("reads both new columns from the steps query", async () => {
    const { pool } = await runStep(step({}), EMAIL_ONLY);
    expect(String(callsMatching(pool.query, /FROM marketing_sequence_steps WHERE sequence_id=\$1 ORDER BY/)[0][0])).toContain("template_id, sms_template_id, email_template_id");
  });

  it("leaves single-channel steps on template_id", async () => {
    const { templatesLoaded } = await runStep(step({ channel: "email", template_id: SINGLE_T }), EMAIL_ONLY);
    expect(templatesLoaded).toEqual([SINGLE_T]);
    expect(sendOne.mock.calls[0][0]).toMatchObject({ subject: "Single subject", html: "<p>Single</p>" });
  });
});

describe("the columns persist and read back", () => {
  it("inserts both, uuid-guarded, camelCase or snake_case", async () => {
    await auth(request(app).post("/api/marketing/sequences")).send({
      name: "Auto", includeTags: ["vip"],
      steps: [
        { channel: "auto", smsTemplateId: SMS_T, emailTemplateId: ` ${EMAIL_T} ` },
        { channel: "auto", sms_template_id: SMS_T, email_template_id: EMAIL_T },
        { channel: "auto", smsTemplateId: "not-a-uuid", emailTemplateId: 42 },
      ],
    });
    const cols = callsMatching(queryMock, /INSERT INTO marketing_sequence_steps/).map((c) => (c[1] as unknown[]).slice(10, 12));
    expect(cols).toEqual([[SMS_T, EMAIL_T], [SMS_T, EMAIL_T], [null, null]]);
  });

  it("returns them when a sequence is read back", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM marketing_sequences WHERE id=\$1 AND silo=\$2/, { rows: [{ id: "seq-1" }], rowCount: 1 }],
      [/FROM marketing_sequence_steps WHERE sequence_id=\$1/, { rows: [{ step_order: 0, channel: "auto", sms_template_id: SMS_T, email_template_id: EMAIL_T }] }],
    ]));
    const r = await auth(request(app).get("/api/marketing/sequences/seq-1"));
    expect(r.body.data.steps[0]).toMatchObject({ sms_template_id: SMS_T, email_template_id: EMAIL_T });
    expect(String(callsMatching(queryMock, /FROM marketing_sequence_steps/)[0][0])).toContain("sms_template_id, email_template_id");
  });

  it("adds the columns idempotently", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS sms_template_id");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS email_template_id");
  });
});
