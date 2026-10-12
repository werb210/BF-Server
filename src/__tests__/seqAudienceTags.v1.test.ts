// BF_SERVER_SEQ_AUDIENCE_TAGS_v1 - sequence audience include and exclude tags.
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

import { enrollSequence, hasSmsConsent, tickSequences } from "../services/sequenceEngine.js";
import marketing from "../routes/marketing.js";

const migration = readFileSync(join(process.cwd(), "migrations", "2026_07_30_seq_audience_tags_v1.sql"), "utf-8");

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

const ENROLL = /INSERT INTO marketing_sequence_enrollments/;
async function enroll(seqRow: Record<string, unknown>) {
  const pool = {
    query: vi.fn(answerBySql([
      [/SELECT silo, audience_tag, audience_include_tags, audience_exclude_tags, quiet_start, quiet_end FROM marketing_sequences/, { rows: [{ silo: "BF", quiet_start: 0, quiet_end: 24, ...seqRow }], rowCount: 1 }],
      [ENROLL, { rows: [], rowCount: 3 }],
    ])),
  };
  const n = await enrollSequence(pool as any, "seq-1");
  const [sql, params] = callsMatching(pool.query, ENROLL)[0] as [string, unknown[]];
  return { n, sql, includeTags: params[3], excludeTags: params[4], params };
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[/INSERT INTO marketing_sequences/, { rows: [{ id: "seq-9" }] }]]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
  sendMarketingSms.mockReset();
  sendMarketingSms.mockResolvedValue({ ok: true, sid: "SM1" });
});

describe("sequence audience include and exclude tags", () => {
  it("adds both columns idempotently", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS audience_include_tags");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS audience_exclude_tags");
  });

  it("accepts composer-style tag lists, normalised, and preserves the legacy tag", async () => {
    await auth(request(app).post("/api/marketing/sequences")).set("X-Silo", "BI")
      .send({ name: "Drip", audienceTag: "legacy", includeTags: [" vip ", "vip", "", "new"], excludeTags: ["dnc"], steps: [{ channel: "email" }] });
    const p = callsMatching(queryMock, /INSERT INTO marketing_sequences/)[0][1] as unknown[];
    expect(p.slice(0, 5)).toEqual(["BI", "Drip", "legacy", ["vip", "new"], ["dnc"]]);
  });

  it("also accepts the audienceIncludeTags / audienceExcludeTags names, and no legacy tag", async () => {
    await auth(request(app).post("/api/marketing/sequences"))
      .send({ name: "Drip", audienceIncludeTags: ["a"], audienceExcludeTags: ["b"], steps: [{ channel: "email" }] });
    const p = callsMatching(queryMock, /INSERT INTO marketing_sequences/)[0][1] as unknown[];
    expect(p.slice(2, 5)).toEqual([null, ["a"], ["b"]]);
  });

  it("returns the lists when a sequence is read", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM marketing_sequences WHERE id=\$1 AND silo=\$2/, { rows: [{ id: "seq-1", audience_tag: "legacy", audience_include_tags: ["vip"], audience_exclude_tags: ["dnc"] }], rowCount: 1 }],
    ]));
    const r = await auth(request(app).get("/api/marketing/sequences/seq-1"));
    expect(r.body.data.item).toMatchObject({ audience_include_tags: ["vip"], audience_exclude_tags: ["dnc"] });
    expect(String(callsMatching(queryMock, /FROM marketing_sequences WHERE id=\$1/)[0][0])).toContain("audience_tag, audience_include_tags, audience_exclude_tags, status");
  });

  it("uses union include matching, folds in audience_tag, and lets exclude win", async () => {
    const out = await enroll({ audience_tag: "legacy", audience_include_tags: ["vip", "legacy"], audience_exclude_tags: ["dnc"] });
    expect(out.n).toBe(3);
    expect(out.includeTags).toEqual(["vip", "legacy"]);
    expect(out.excludeTags).toEqual(["dnc"]);
    expect(out.sql).toContain("COALESCE(c.tags, '{}') && $4::text[]");
    expect(out.sql).toContain("NOT (COALESCE(c.tags, '{}') && $5::text[])");
    expect(out.params[1]).toBe("BF");
  });

  // BF_SERVER_SEQ_AUDIENCE_FAIL_CLOSED_TEST_v32 - no tags selected means no audience.
  it("treats an empty include list as no audience, and still folds in audience_tag", async () => {
    const empty = await enroll({ audience_tag: null, audience_include_tags: null, audience_exclude_tags: null });
    expect(empty.includeTags).toEqual([]);
    expect(empty.excludeTags).toEqual([]);
    expect(empty.sql).toContain("cardinality($4::text[]) > 0");
    expect(empty.sql).not.toContain("cardinality($4::text[]) = 0 OR");
    const legacy = await enroll({ audience_tag: "legacy", audience_include_tags: [], audience_exclude_tags: null });
    expect(legacy.includeTags).toEqual(["legacy"]);
  });

  it("gates SMS on consent, not merely on the absence of an opt-out", async () => {
    const DAY = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
    expect(hasSmsConsent({ sms_consent: true })).toBe(true);
    expect(hasSmsConsent({ consent_basis: "implied_transaction", consent_at: ago(365) })).toBe(true);
    expect(hasSmsConsent({ consent_basis: "implied_transaction", consent_at: ago(800) })).toBe(false);
    expect(hasSmsConsent({ consent_basis: "implied_inquiry", consent_at: ago(90) })).toBe(true);
    expect(hasSmsConsent({ consent_basis: "implied_inquiry", consent_at: ago(200) })).toBe(false);
    expect(hasSmsConsent({ sms_consent: false, consent_basis: null, consent_at: ago(1) })).toBe(false);

    // An opted-in-by-default contact (no opt-out, no consent) is not texted by an auto step.
    let claimed = false;
    const pool = {
      query: vi.fn(answerBySql([
        [/UPDATE marketing_sequence_enrollments SET status='running'/, () => (claimed ? { rows: [] } : ((claimed = true), { rows: [{ id: "e1", sequence_id: "s1", contact_id: "c1", current_step: 0, enrolled_at: ago(1), stop_on_reply: false, quiet_start: 0, quiet_end: 24 }] }))],
        [/FROM marketing_sequence_steps WHERE sequence_id=\$1 ORDER BY/, { rows: [{ channel: "auto", wait_minutes: 0, condition: "always", subject: "S", body: "Hi", html: null, link_url: null, template_id: null }] }],
        [/FROM contacts WHERE id=\$1/, { rows: [{ id: "c1", silo: "BF", email: "a@x.test", phone: "+14035550101", name: "A", sms_opt_out: false, marketing_opt_out: false, sms_consent: false, consent_basis: null, consent_at: null, line_type: "mobile" }] }],
        [/INSERT INTO sequence_sends/, { rows: [{ id: "ss" }] }],
      ])),
    };
    await tickSequences(pool as any);
    expect(sendMarketingSms).not.toHaveBeenCalled();
    expect(sendOne).toHaveBeenCalledTimes(1);
  });
});
