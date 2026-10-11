// Audit fixes Oct 11 - webhooks that accepted unsigned input.
//   BF_SERVER_SIGNNOW_FAIL_CLOSED_v1       SignNow webhook accepted unsigned posts when the secret was unset.
//   BF_SERVER_SENDGRID_FAIL_CLOSED_v1      SendGrid events accepted unsigned when the key was unset.
//   BF_SERVER_GRAPH_CLIENTSTATE_REQUIRED_v1 Graph notifications without clientState skipped the check.
//   BF_SERVER_MMS_FETCH_ALLOWLIST_v1       media fetch sent Twilio credentials to any URL containing "api.twilio.com".
import express from "express";
import request from "supertest";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => ({
  ...(await vi.importActual<any>("../db.js")),
  pool: { query: queryMock },
  dbQuery: (sql: string, p?: unknown[]) => queryMock(sql, p),
  runQuery: (sql: string, p?: unknown[]) => queryMock(sql, p),
}));

const realFetch = globalThis.fetch;
beforeEach(() => { queryMock.mockReset(); queryMock.mockResolvedValue({ rows: [], rowCount: 0 }); });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.SIGNNOW_WEBHOOK_SECRET; delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY; });

function rawJsonApp(router: express.Router, mount: string) {
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  a.use(mount, router);
  return a;
}

describe("SignNow webhook", () => {
  const payload = JSON.stringify({ event: "document.complete", document_id: "doc-1" });

  it("rejects everything (401) when SIGNNOW_WEBHOOK_SECRET is unset, without touching the database", async () => {
    const router = (await import("../routes/signnow.js")).default;
    const r = await request(rawJsonApp(router, "/api")).post("/api/webhooks/signnow").set("Content-Type", "application/json").send(payload);
    expect(r.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects a bad signature and accepts SignNow's base64 HMAC of the raw body", async () => {
    process.env.SIGNNOW_WEBHOOK_SECRET = "sn-secret";
    const router = (await import("../routes/signnow.js")).default;
    const a = rawJsonApp(router, "/api");
    const bad = await request(a).post("/api/webhooks/signnow").set("Content-Type", "application/json").set("x-signnow-signature", "nope").send(payload);
    expect(bad.status).toBe(401);
    const sig = crypto.createHmac("sha256", "sn-secret").update(payload).digest("base64");
    const good = await request(a).post("/api/webhooks/signnow").set("Content-Type", "application/json").set("x-signnow-signature", sig).send(payload);
    expect(good.status).not.toBe(401);
  });

  it("subscriptions are created and updated WITH the secret", async () => {
    process.env.SIGNNOW_WEBHOOK_SECRET = "sn-secret";
    process.env.SIGNNOW_API_KEY = "k";
    const seen: Array<{ method: string; url: string; body: any }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      seen.push({ method: init?.method ?? "GET", url: u, body: init?.body ? JSON.parse(init.body) : null });
      if (u.endsWith("/user")) return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      if (u.endsWith("/api/v2/events") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ data: [{ id: "sub-1", event: "user.document.complete", entity_id: "user-1", json_attributes: { callback: "https://cb.test/hook" } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "new" }), { status: 201 });
    }) as any;
    const { ensureUserSignedSubscription } = await import("../signnow/signnowClient.js");
    const created = await ensureUserSignedSubscription("https://cb.test/hook", "user.document.fieldinvite.signed");
    expect(created.created).toBe(true);
    const post = seen.find((s) => s.method === "POST" && s.url.endsWith("/api/v2/events"));
    expect(post?.body.attributes.secret_key).toBe("sn-secret");
    const updated = await ensureUserSignedSubscription("https://cb.test/hook", "user.document.complete");
    expect(updated.created).toBe(false);
    const put = seen.find((s) => s.method === "PUT");
    expect(put?.url).toMatch(/\/api\/v2\/events\/sub-1$/);
    expect(put?.body.attributes.secret_key).toBe("sn-secret");
    delete process.env.SIGNNOW_API_KEY;
  });
});

describe("SendGrid event webhook", () => {
  it("rejects events when SENDGRID_WEBHOOK_PUBLIC_KEY is unset", async () => {
    const router = (await import("../routes/sendgridWebhook.js")).default;
    const r = await request(rawJsonApp(router, "/api/webhooks/sendgrid")).post("/api/webhooks/sendgrid")
      .set("Content-Type", "application/json").send(JSON.stringify([{ event: "unsubscribe", email: "a@example.com" }]));
    expect(r.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed batch", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const der = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = der;
    const body = JSON.stringify([{ event: "delivered", email: "a@example.com" }]);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createSign("sha256").update(ts + body).sign(privateKey, "base64");
    const router = (await import("../routes/sendgridWebhook.js")).default;
    const r = await request(rawJsonApp(router, "/api/webhooks/sendgrid")).post("/api/webhooks/sendgrid")
      .set("Content-Type", "application/json")
      .set("X-Twilio-Email-Event-Webhook-Signature", sig)
      .set("X-Twilio-Email-Event-Webhook-Timestamp", ts)
      .send(body);
    expect(r.status).toBe(200);
  });
});

describe("Graph mail notifications", () => {
  const sub = { user_id: "u1", client_state: "expected-state", resource: "me/mailFolders('inbox')/messages" };
  async function run(values: any[]) {
    queryMock.mockImplementation(async (sql: string) => (/FROM graph_mail_subscriptions/.test(sql) ? { rows: [sub] } : { rows: [] }));
    const { handleGraphNotifications } = await import("../modules/o365/mailSubscriptions.js");
    await handleGraphNotifications({ query: queryMock } as any, values);
    return queryMock.mock.calls.map((c) => String(c[0]));
  }

  it("drops a notification with no clientState", async () => {
    const sqls = await run([{ subscriptionId: "s1" }]);
    expect(sqls.filter((s) => !/graph_mail_subscriptions/.test(s))).toEqual([]);
  });

  it("drops a notification with the wrong clientState", async () => {
    const sqls = await run([{ subscriptionId: "s1", clientState: "forged" }]);
    expect(sqls.filter((s) => !/graph_mail_subscriptions/.test(s))).toEqual([]);
  });

  it("clientStateMatches is exact", async () => {
    const { clientStateMatches } = await import("../modules/o365/mailSubscriptions.js");
    expect(clientStateMatches("abc", "abc")).toBe(true);
    expect(clientStateMatches(undefined, "abc")).toBe(false);
    expect(clientStateMatches("", "abc")).toBe(false);
    expect(clientStateMatches("abd", "abc")).toBe(false);
  });

  it("subscriptions are created with a clientState", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/modules/o365/mailSubscriptions.ts", "utf8");
    expect(src).toMatch(/clientState,\n\s*\}\),/);
  });
});

describe("Twilio media fetch", () => {
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "tok";
  });

  it.each([
    "https://evil.example/steal?api.twilio.com",
    "http://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1",
    "https://api.twilio.com.evil.example/x",
    "https://media.twiliocdn.com/x",
    "not a url",
  ])("refuses %s and never sends credentials", async (url) => {
    const f = vi.fn(async () => new Response("x", { status: 200 }));
    globalThis.fetch = f as any;
    const { fetchTwilioMedia } = await import("../services/mmsMedia.js");
    expect(await fetchTwilioMedia(url)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("fetches https://api.twilio.com with Basic auth", async () => {
    const f = vi.fn(async (_u: any, init: any) => {
      expect(init.headers.Authorization).toBe("Basic " + Buffer.from("AC1:tok").toString("base64"));
      return new Response("img", { status: 200, headers: { "content-type": "image/png" } });
    });
    globalThis.fetch = f as any;
    const { fetchTwilioMedia } = await import("../services/mmsMedia.js");
    const r = await fetchTwilioMedia("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1");
    expect(r?.contentType).toBe("image/png");
    expect(f).toHaveBeenCalledTimes(1);
  });
});
