// BF_SERVER_SENDGRID_WEBHOOK_VISIBILITY_v20
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import { answerBySql } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: q, runQuery: q, query: q };
});
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: async () => undefined }));

import { createApp } from "../app.js";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const TS = "1700000000";
const signBody = (body: string) => crypto.sign("sha256", Buffer.from(TS + body), privateKey).toString("base64");

const app = createApp();
const post = (body: string, headers: Record<string, string>) => {
  let r = request(app).post("/api/webhooks/sendgrid").set("Content-Type", "application/json");
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
};

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const logged = () => JSON.stringify([...errorSpy.mock.calls, ...logSpy.mock.calls, ...(vi.mocked(console.warn).mock?.calls ?? [])]);

beforeEach(() => {
  process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = KEY;
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([[/SELECT id FROM contacts/, { rows: [{ id: "c-1" }] }]]));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
});

const BODY = JSON.stringify([{ email: "a@x.com", event: "delivered", sg_event_id: "e1" }]);

describe("sendgrid webhook visibility", () => {
  it("logs a rejection with the three things that distinguish the causes", async () => {
    const r = await post(BODY, { "X-Twilio-Email-Event-Webhook-Timestamp": TS });
    expect(r.status).toBe(403);
    const call = errorSpy.mock.calls.find((c) => String(c[0]).includes("REJECTED 403 signature verification failed"));
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      keyConfigured: true,
      signatureHeaderPresent: false,
      timestampHeaderPresent: true,
      rawBodyFromVerifyHook: true,
      rawBodyBytes: Buffer.byteLength(BODY),
    });
  });

  it("logs an accepted batch so a passing test is visible too", async () => {
    const body = JSON.stringify([
      { email: "a@x.com", event: "delivered" },
      { email: "", event: "open" },
    ]);
    h.query.mockImplementation(answerBySql([[/SELECT id FROM contacts/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "a@x.com" ? [{ id: "c-1" }] : [] })]]));
    const r = await post(body, { "X-Twilio-Email-Event-Webhook-Signature": signBody(body), "X-Twilio-Email-Event-Webhook-Timestamp": TS });
    expect(r.status).toBe(200);
    const call = logSpy.mock.calls.find((c) => c[0] === "[sendgrid-webhook] accepted");
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ events: 2, contactsResolved: 1 });
  });

  // BF_SERVER_v784_WEBHOOK_SIGNATURES - an unset key now rejects instead of accepting unsigned posts.
  it("logs and rejects when the key is unset", async () => {
    delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
    const r = await post(BODY, { "X-Twilio-Email-Event-Webhook-Signature": signBody(BODY), "X-Twilio-Email-Event-Webhook-Timestamp": TS });
    expect(r.status).toBe(403);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("SENDGRID_WEBHOOK_PUBLIC_KEY unset - rejecting"))).toBe(true);
    expect(logSpy.mock.calls.some((c) => c[0] === "[sendgrid-webhook] accepted")).toBe(false);
    expect(h.query).not.toHaveBeenCalled();
  });

  it("never logs the key or the signature themselves", async () => {
    const badSig = signBody("something else entirely");
    const r = await post(BODY, { "X-Twilio-Email-Event-Webhook-Signature": badSig, "X-Twilio-Email-Event-Webhook-Timestamp": TS });
    expect(r.status).toBe(403);
    const text = logged();
    expect(text).not.toContain(badSig);
    expect(text).not.toContain(KEY);
    const call = errorSpy.mock.calls.find((c) => String(c[0]).includes("REJECTED 403"));
    expect(call![1]).toMatchObject({ keyLength: KEY.length, signatureHeaderPresent: true });
  });

  it("still relies on rawBody captured by the global json verify hook", async () => {
    // The exact bytes SendGrid signed, with whitespace JSON.stringify would not reproduce.
    const body = '[ { "email" : "a@x.com", "event" : "delivered" } ]';
    const r = await post(body, { "X-Twilio-Email-Event-Webhook-Signature": signBody(body), "X-Twilio-Email-Event-Webhook-Timestamp": TS });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});
