// BF_SERVER_EMAIL_HARDENING_v1 - behaviour: the fixes stay in place.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  landing: vi.fn(async () => ({ url: "https://x.test/view" })),
}));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: q, runQuery: q, query: q };
});
vi.mock("../middleware/auth.js", async (orig) => {
  const real: any = await orig();
  const pass = (_req: any, _res: any, next: any) => next();
  return { ...real, requireAuth: pass, requireCapability: () => pass, requireAuthorization: () => pass };
});
vi.mock("../services/landingPage.service.js", async (orig) => {
  const real: any = await orig();
  return { ...real, createLandingPageFromHtml: h.landing, withViewInBrowser: (html: string, url: string) => `${html}<a href="${url}">view</a>` };
});
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));

import { createApp } from "../app.js";
import marketing from "../routes/marketing.js";
import { sendOne } from "../services/sendgridService.js";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const TS = "1700000000";
const sign = (body: string) => crypto.sign("sha256", Buffer.from(TS + body), privateKey).toString("base64");

const app = createApp();
const postHook = (body: string) =>
  request(app)
    .post("/api/webhooks/sendgrid")
    .set("Content-Type", "application/json")
    .set("X-Twilio-Email-Event-Webhook-Signature", sign(body))
    .set("X-Twilio-Email-Event-Webhook-Timestamp", TS)
    .send(body);

const env = { ...process.env };
beforeEach(() => {
  process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([]));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...env };
});

describe("email hardening v1", () => {
  it("app.ts captures the raw body, so a signature over the exact bytes verifies", async () => {
    // Whitespace JSON.stringify would not reproduce: only the captured raw bytes verify.
    const body = '[ {"event": "delivered",   "contact_id": "c-1"} ]';
    const r = await postHook(body);
    expect(r.status).toBe(200);
    expect(callsMatching(h.query, "INSERT INTO crm_timeline_events")).toHaveLength(1);
  });

  it("app.ts keeps the global json limit at 10 MB", async () => {
    const pad = (bytes: number) => JSON.stringify({ pad: "x".repeat(bytes) });
    // Under the limit the body reaches the webhook (unsigned -> its own 403); over it, the parser refuses it first.
    const under = await request(app).post("/api/webhooks/sendgrid").set("Content-Type", "application/json").send(pad(9 * 1024 * 1024));
    expect(under.status).toBe(403);
    const over = await request(app).post("/api/webhooks/sendgrid").set("Content-Type", "application/json").send(pad(10 * 1024 * 1024 + 10));
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.status).not.toBe(403);
    expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes("REJECTED 403"))).toBe(true);
    expect(vi.mocked(console.error).mock.calls.filter((c) => String(c[0]).includes("REJECTED 403"))).toHaveLength(1);
  });

  it("sendgrid webhook only suppresses permanent signals", async () => {
    const events = [
      { event: "dropped", contact_id: "c-dropped" },
      { event: "bounce", type: "blocked", contact_id: "c-soft" },
      { event: "deferred", contact_id: "c-deferred" },
      { event: "bounce", type: "bounce", contact_id: "c-hard" },
      { event: "bounce", contact_id: "c-untyped" },
      { event: "spamreport", contact_id: "c-spam" },
      { event: "unsubscribe", contact_id: "c-unsub" },
      { event: "group_unsubscribe", contact_id: "c-group" },
    ];
    const r = await postHook(JSON.stringify(events));
    expect(r.status).toBe(200);
    const suppressed = callsMatching(h.query, /UPDATE contacts SET marketing_opt_out = true/).map((c) => (c[1] as unknown[])[0]);
    expect(suppressed.sort()).toEqual(["c-group", "c-hard", "c-spam", "c-unsub", "c-untyped"]);
    // Every event still lands on the timeline.
    expect(callsMatching(h.query, "INSERT INTO crm_timeline_events")).toHaveLength(events.length);
  });

  it("sendOne has a hard timeout so a hung socket cannot freeze the send-queue worker", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      // A socket that never answers: only the abort ends it.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
      });
    }));
    const pending = sendOne({ to: "a@x.com", subject: "s", html: "<p>h</p>" });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: false, status: 0 });
  });

  describe("raw email panel", () => {
    const panel = express();
    panel.use(express.json());
    panel.use((req: any, _res, next) => { req.user = { userId: "u1", role: "Admin", silo: "BF" }; next(); });
    panel.use("/api/marketing", marketing);

    beforeEach(() => {
      process.env.SENDGRID_API_KEY = "SG.test";
      process.env.SENDGRID_FROM = "news@boreal.test";
      h.query.mockImplementation(answerBySql([
        [/SELECT count\(\*\)::int AS n\s+FROM contacts c/, { rows: [{ n: 4 }] }],
        [/INSERT INTO marketing_send_jobs/, { rows: [{ id: "job-1", not_before: "2026-10-11T00:05:00Z" }] }],
      ]));
      h.landing.mockReset();
      h.landing.mockImplementation(async () => ({ url: "https://x.test/view" }));
    });

    it("counts and queues with the include and exclude tags", async () => {
      const r = await request(panel).post("/api/marketing/email/send").send({ subject: "Hi", html: "<p>x</p>", tags: ["vip", " vip ", "lead"], excludeTags: "funded, declined" });
      expect(r.status).toBe(200);
      expect(r.body.data.queued).toBe(true);
      const [count] = callsMatching(h.query, /SELECT count\(\*\)::int AS n\s+FROM contacts c/);
      expect(count[1]).toEqual(["BF", null, ["vip", "lead"], ["funded", "declined"]]);
      const [job] = callsMatching(h.query, "INSERT INTO marketing_send_jobs");
      const payload = JSON.parse(String((job[1] as unknown[])[2]));
      expect(payload).toMatchObject({ tags: ["vip", "lead"], excludeTags: ["funded", "declined"] });
      expect(payload.html).toContain("https://x.test/view");
    });

    it("a failed landing-page insert does not stop the blast", async () => {
      h.landing.mockImplementation(async () => { throw new Error("landing insert failed"); });
      const r = await request(panel).post("/api/marketing/email/send").send({ subject: "Hi", html: "<p>x</p>", tags: ["vip"] });
      expect(r.status).toBe(200);
      expect(r.body.data.queued).toBe(true);
      expect(vi.mocked(console.error).mock.calls.some((c) => c[0] === "landing_page_failed")).toBe(true);
      const [job] = callsMatching(h.query, "INSERT INTO marketing_send_jobs");
      expect(JSON.parse(String((job[1] as unknown[])[2])).html).toBe("<p>x</p>");
    });
  });
});
