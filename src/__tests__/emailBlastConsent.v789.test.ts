// BF_SERVER_v789_EMAIL_BLAST_CONSENT - email blasts need an audience, and reach only
// contacts with live CASL consent who have not opted out of marketing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const h = vi.hoisted(() => ({ sql: [] as string[], jobs: [] as unknown[][] }));

vi.mock("../middleware/auth.js", async (orig) => {
  const real: any = await orig();
  const pass = (_req: any, _res: any, next: any) => next();
  return { ...real, requireAuth: pass, requireCapability: () => pass, requireAuthorization: () => pass };
});
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const query = async (sql: string, params: unknown[] = []) => {
    h.sql.push(sql);
    if (/SELECT count\(\*\)::int AS n\s+FROM contacts c/.test(sql)) return { rows: [{ n: 3 }] };
    if (/INSERT INTO marketing_send_jobs/.test(sql)) { h.jobs.push(params); return { rows: [{ id: "job-1", not_before: "2026-10-11T00:05:00Z" }] }; }
    if (/FROM contacts c LEFT JOIN companies co/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  return { ...real, pool: { query }, runQuery: query };
});
vi.mock("../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendgridConfigured: () => true, sendOne: async () => ({ ok: true }) };
});
vi.mock("../services/landingPage.service.js", async (orig) => {
  const real: any = await orig();
  return { ...real, createLandingPageFromHtml: async () => ({ url: "https://x.test/v" }), withViewInBrowser: (html: string) => html };
});

import marketing, { emailAudienceMissing } from "../routes/marketing.js";
import { countEmailRecipients, runEmailSend, EMAIL_BLAST_ELIGIBLE_SQL } from "../services/marketingSendRunner.js";
import { CONSENT_SQL } from "../services/smsConsent.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.user = { userId: "u1", role: "Admin", silo: "BF" }; next(); });
app.use("/api/marketing", marketing);

beforeEach(() => { h.sql.length = 0; h.jobs.length = 0; });

describe("v789 email blast audience is required", () => {
  it("/email/send with no tag and no include tags is 400 audience_required and queues nothing", async () => {
    const r = await request(app).post("/api/marketing/email/send").send({ subject: "Hi", html: "<p>x</p>", tags: [], excludeTags: ["vip"] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("audience_required");
    expect(h.jobs).toEqual([]);
    expect(h.sql.some((s) => /FROM contacts/.test(s))).toBe(false);
  });

  it("/email/send-template with an empty audience is 400 audience_required", async () => {
    const r = await request(app).post("/api/marketing/email/send-template").send({ subject: "Hi", headline: "x", body: "y", tag: "  " });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("audience_required");
    expect(h.jobs).toEqual([]);
  });

  it("a test send still needs no audience", async () => {
    const r = await request(app).post("/api/marketing/email/send").send({ subject: "Hi", html: "<p>x</p>", test: "me@boreal.test" });
    expect(r.status).toBe(200);
    expect(r.body.data.test).toBe(true);
  });

  it("a tagged blast is counted with the consent predicate and queued", async () => {
    const r = await request(app).post("/api/marketing/email/send").send({ subject: "Hi", html: "<p>x</p>", tags: ["vip"] });
    expect(r.status).toBe(200);
    expect(r.body.data.queued).toBe(true);
    expect(h.jobs).toHaveLength(1);
    const count = h.sql.find((s) => /SELECT count\(\*\)::int AS n\s+FROM contacts c/.test(s))!;
    expect(count).toContain(CONSENT_SQL);
    expect(count).toContain("COALESCE(c.marketing_opt_out,false) = false");
  });

  it("emailAudienceMissing", () => {
    expect(emailAudienceMissing(null, null)).toBe(true);
    expect(emailAudienceMissing(null, [])).toBe(true);
    expect(emailAudienceMissing("  ", null)).toBe(true);
    expect(emailAudienceMissing("vip", null)).toBe(false);
    expect(emailAudienceMissing(null, ["vip"])).toBe(false);
  });
});

describe("v789 email blast recipients pass the sequence CASL consent check plus opt-out", () => {
  it("the shared predicate is CONSENT_SQL (express, implied 2y / 6mo) and marketing opt-out", () => {
    expect(EMAIL_BLAST_ELIGIBLE_SQL).toContain(CONSENT_SQL);
    expect(CONSENT_SQL).toContain("interval '2 years'");
    expect(CONSENT_SQL).toContain("interval '6 months'");
    expect(EMAIL_BLAST_ELIGIBLE_SQL).toContain("COALESCE(c.marketing_opt_out,false) = false");
  });

  it("count and send both apply it", async () => {
    const seen: string[] = [];
    const pool: any = { query: async (sql: string) => { seen.push(sql); return /count\(\*\)/.test(sql) ? { rows: [{ n: 0 }] } : { rows: [] }; } };
    await countEmailRecipients(pool, "BF", "vip");
    await runEmailSend(pool, { silo: "BF", tag: "vip", subject: "s", html: "h" });
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s).toContain(CONSENT_SQL);
  });
});
