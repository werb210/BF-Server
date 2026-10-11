// BF_SERVER_v784_WEBHOOK_SIGNATURES - inbound webhooks fail closed on missing/invalid signatures.
import express from "express";
import request from "supertest";
import crypto from "node:crypto";
import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, TWILIO_TOKEN } = vi.hoisted(() => {
  const TWILIO_TOKEN = "test-twilio-auth-token";
  process.env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
  return { queryMock: vi.fn(), TWILIO_TOKEN };
});
// The global setup (src/tests/mocks/externalMocks.ts) replaces twilio with a stub that has no
// validateRequest; signature checks here need the real implementation.
vi.mock("twilio", async () => await vi.importActual<any>("twilio"));
vi.mock("../db.js", async () => ({
  ...(await vi.importActual<any>("../db.js")),
  pool: { query: queryMock },
  dbQuery: queryMock,
}));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});
beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([[/FROM communications_conversations/, { rows: [{ id: "c1" }], rowCount: 1 }]]));
});

describe("Twilio SMS inbound webhook signature", () => {
  const PUBLIC_URL = "https://server.test/api/webhooks/twilio/sms-inbound";
  async function app() {
    const r = (await import("../routes/smsInboundWebhook.js")).default;
    const a = express();
    a.use("/api", r);
    return a;
  }
  const params = { From: "+15551234567", To: "+15557654321", Body: "hello there", MessageSid: "SM784" };

  it("rejects an unsigned POST and writes nothing", async () => {
    const res = await request(await app())
      .post("/api/webhooks/twilio/sms-inbound")
      .set("X-Forwarded-Proto", "https").set("X-Forwarded-Host", "server.test")
      .type("form").send(params);
    expect(res.status).toBe(403);
    expect(callsMatching(queryMock, /INSERT INTO communications_messages/)).toHaveLength(0);
  });

  it("rejects a POST with a wrong signature", async () => {
    const res = await request(await app())
      .post("/api/webhooks/twilio/sms-inbound")
      .set("X-Forwarded-Proto", "https").set("X-Forwarded-Host", "server.test")
      .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature("other-token", PUBLIC_URL, params))
      .type("form").send(params);
    expect(res.status).toBe(403);
    expect(callsMatching(queryMock, /INSERT INTO communications_messages/)).toHaveLength(0);
  });

  it("accepts a correctly signed POST", async () => {
    const res = await request(await app())
      .post("/api/webhooks/twilio/sms-inbound")
      .set("X-Forwarded-Proto", "https").set("X-Forwarded-Host", "server.test")
      .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(TWILIO_TOKEN, PUBLIC_URL, params))
      .type("form").send(params);
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Response/>");
    expect(callsMatching(queryMock, /INSERT INTO communications_messages/)).toHaveLength(1);
  });
});

describe("fetchTwilioMedia host allow-list", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
    vi.stubEnv("TWILIO_AUTH_TOKEN", TWILIO_TOKEN);
  });

  it.each([
    "https://evil.example/api.twilio.com/2010-04-01/Media/ME1",
    "https://api.twilio.com.evil.example/Media/ME1",
    "http://api.twilio.com/2010-04-01/Media/ME1",
    "https://evil.example/?u=https://api.twilio.com/",
    "not a url",
  ])("does not fetch %s", async (url) => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    const { fetchTwilioMedia } = await import("../services/mmsMedia.js");
    expect(await fetchTwilioMedia(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches api.twilio.com over https with Basic auth", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("img"), { status: 200, headers: { "content-type": "image/png" } }));
    globalThis.fetch = fetchMock as any;
    const { fetchTwilioMedia } = await import("../services/mmsMedia.js");
    const out = await fetchTwilioMedia("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM1/Media/ME1");
    expect(out?.contentType).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Basic " + Buffer.from(`ACtest:${TWILIO_TOKEN}`).toString("base64"));
  });
});

describe("SignNow webhook signature", () => {
  const SECRET = "signnow-secret-784";
  async function app() {
    const r = (await import("../routes/signnow.js")).default;
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    a.use("/api", r);
    return a;
  }
  const body = JSON.stringify({ event: "ping" });
  const hmac = (secret: string) => crypto.createHmac("sha256", secret).update(body);

  it("rejects with 401 when SIGNNOW_WEBHOOK_SECRET is unset, even with a signature", async () => {
    vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", "");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(await app()).post("/api/webhooks/signnow")
      .set("Content-Type", "application/json").set("x-signnow-signature", hmac("anything").digest("base64")).send(body);
    expect(res.status).toBe(401);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("SIGNNOW_WEBHOOK_SECRET unset - rejecting"))).toBe(true);
    errSpy.mockRestore();
  });

  it("rejects an unsigned webhook with 401", async () => {
    vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", SECRET);
    const res = await request(await app()).post("/api/webhooks/signnow").set("Content-Type", "application/json").send(body);
    expect(res.status).toBe(401);
  });

  it("rejects a bad signature with 401", async () => {
    vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", SECRET);
    for (const sig of [hmac("wrong").digest("base64"), hmac("wrong").digest("hex"), "garbage"]) {
      const res = await request(await app()).post("/api/webhooks/signnow")
        .set("Content-Type", "application/json").set("x-signnow-signature", sig).send(body);
      expect(res.status).toBe(401);
    }
  });

  it("accepts a base64 HMAC-SHA256 signature", async () => {
    vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", SECRET);
    const res = await request(await app()).post("/api/webhooks/signnow")
      .set("Content-Type", "application/json").set("x-signnow-signature", hmac(SECRET).digest("base64")).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: true });
  });

  it("accepts a hex HMAC-SHA256 signature", async () => {
    vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", SECRET);
    const res = await request(await app()).post("/api/webhooks/signnow")
      .set("Content-Type", "application/json").set("x-signnow-signature", hmac(SECRET).digest("hex")).send(body);
    expect(res.status).toBe(200);
  });
});

describe("SendGrid webhook", () => {
  it("rejects events when SENDGRID_WEBHOOK_PUBLIC_KEY is unset", async () => {
    vi.stubEnv("SENDGRID_WEBHOOK_PUBLIC_KEY", "");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = (await import("../routes/sendgridWebhook.js")).default;
    const a = express();
    a.use("/api/webhooks/sendgrid", r);
    const res = await request(a).post("/api/webhooks/sendgrid")
      .set("Content-Type", "application/json")
      .send(JSON.stringify([{ email: "a@b.com", event: "unsubscribe" }]));
    expect(res.status).toBe(403);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("SENDGRID_WEBHOOK_PUBLIC_KEY unset - rejecting"))).toBe(true);
    expect(callsMatching(queryMock, /marketing_opt_out/)).toHaveLength(0);
    errSpy.mockRestore();
  });
});

describe("ensureSignnowWebhook registers subscriptions with secret_key", () => {
  const CB = "https://server.test/api/webhooks/signnow";
  const SECRET = "signnow-secret-784";
  type Call = { method: string; path: string; body: any };

  function stubSignNow(existing: unknown[]): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
      const u = new URL(String(input));
      const method = String(init.method ?? "GET");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, path: u.pathname, body });
      let out: unknown = {};
      if (method === "GET" && u.pathname === "/user") out = { id: "u1" };
      else if (method === "GET" && u.pathname === "/api/v2/events") out = { data: existing };
      else if (method === "POST" && u.pathname === "/api/v2/events") out = { id: "new" };
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    return calls;
  }

  beforeEach(() => {
    vi.stubEnv("SIGNNOW_API_KEY", "sn-key");
    vi.stubEnv("SIGNNOW_WEBHOOK_URL", CB);
    vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", SECRET);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("creates new subscriptions with attributes.secret_key", async () => {
    const calls = stubSignNow([]);
    const { ensureSignnowWebhook } = await import("../signnow/ensureWebhookSubscription.js");
    await ensureSignnowWebhook();
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/api/v2/events");
    expect(posts.map((p) => p.body.event).sort()).toEqual(["user.document.complete", "user.document.fieldinvite.signed"]);
    for (const p of posts) expect(p.body.attributes).toMatchObject({ callback: CB, secret_key: SECRET });
  });

  it("updates an existing active subscription that lacks a secret in place, and leaves one that has it", async () => {
    const calls = stubSignNow([
      { id: "s1", event: "user.document.fieldinvite.signed", entity_id: "u1", json_attributes: { callback_url: CB, use_tls_12: true } },
      { id: "s2", event: "user.document.complete", entity_id: "u1", json_attributes: { callback_url: CB, secret_key: SECRET } },
    ]);
    const { ensureSignnowWebhook } = await import("../signnow/ensureWebhookSubscription.js");
    await ensureSignnowWebhook();
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/v2/events")).toHaveLength(0);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe("/api/v2/events/s1");
    expect(puts[0].body).toMatchObject({ event: "user.document.fieldinvite.signed", entity_id: "u1", action: "callback", attributes: { callback: CB, secret_key: SECRET } });
  });
});
