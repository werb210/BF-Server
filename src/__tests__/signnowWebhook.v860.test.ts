// BF_SERVER_v860_SIGNNOW_WEBHOOK
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db.js", () => ({
  dbQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
}));

describe("v860 SignNow callback URL", () => {
  it("adds v=860 once, keeping any existing query", async () => {
    const { signedCallbackUrl } = await import("../signnow/ensureWebhookSubscription.js");
    expect(signedCallbackUrl("https://x.test/api/webhooks/signnow")).toBe("https://x.test/api/webhooks/signnow?v=860");
    expect(signedCallbackUrl("https://x.test/api/webhooks/signnow?a=1")).toBe("https://x.test/api/webhooks/signnow?a=1&v=860");
    expect(signedCallbackUrl("https://x.test/api/webhooks/signnow?v=860")).toBe("https://x.test/api/webhooks/signnow?v=860");
  });
});

describe("v860 SignNow subscription setup", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubEnv("SIGNNOW_API_KEY", "sn-key");
    vi.stubEnv("SIGNNOW_WEBHOOK_URL", "https://server.test/api/webhooks/signnow");
    vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", "secret-860");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => { globalThis.fetch = realFetch; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("logs a failed subscription list instead of swallowing it, then registers with the secret", async () => {
    const posts: any[] = [];
    globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
      const u = new URL(String(input));
      const method = String(init.method ?? "GET");
      if (method === "GET" && u.pathname === "/user") return new Response(JSON.stringify({ id: "u1" }), { status: 200 });
      if (method === "GET" && u.pathname === "/api/v2/events") return new Response("nope", { status: 403 });
      if (method === "POST") { posts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "n" }), { status: 200 }); }
      return new Response("{}", { status: 200 });
    }) as any;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ensureSignnowWebhook } = await import("../signnow/ensureWebhookSubscription.js");
    await ensureSignnowWebhook();
    expect(err.mock.calls.some((c) => String(c[0]).includes("could not list subscriptions"))).toBe(true);
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(p.attributes).toMatchObject({ callback: "https://server.test/api/webhooks/signnow?v=860", secret_key: "secret-860" });
  });
});

describe("v860 rejected callbacks say why", () => {
  let router: import("express").Router;
  beforeAll(async () => {
    router = (await import("../routes/signnow.js")).default;
  }, 30000);
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  async function app() {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    a.use("/api", router);
    return a;
  }
  it("no signature header", async () => {
    vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", "secret-860");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(await app()).post("/api/webhooks/signnow?v=860").set("Content-Type", "application/json").send(JSON.stringify({ event: "user.document.complete" }));
    expect(res.status).toBe(401);
    const call = warn.mock.calls.find((c) => String(c[0]).includes("rejected"));
    expect(call?.[1]).toMatchObject({ why: "no_signature_header", signatureLength: 0, callbackVersion: "860" });
  });
  it("wrong signature", async () => {
    vi.stubEnv("SIGNNOW_WEBHOOK_SECRET", "secret-860");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(await app()).post("/api/webhooks/signnow").set("Content-Type", "application/json").set("x-signnow-signature", "abc").send(JSON.stringify({ event: "user.document.complete" }));
    expect(res.status).toBe(401);
    const call = warn.mock.calls.find((c) => String(c[0]).includes("rejected"));
    expect(call?.[1]).toMatchObject({ why: "signature_mismatch", signatureLength: 3, signHeaders: ["x-signnow-signature"] });
    expect(JSON.stringify(call)).not.toContain("secret-860");
  });
});
