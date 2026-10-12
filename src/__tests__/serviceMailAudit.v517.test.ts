// BF_SERVER_BLOCK_v517_SERVICE_MAIL_AUDIT
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const { sendViaGraph } = vi.hoisted(() => ({ sendViaGraph: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../services/email/graphSendService.js", () => ({ sendViaGraph }));
vi.mock("../services/smsService.js", () => ({ sendSMS: vi.fn() }));

const TOKEN = "test-token-v517";

async function sendMail(body: Record<string, unknown>) {
  const { default: router } = await import("../routes/serviceBridge.js");
  const app = express();
  app.use(express.json());
  app.use("/api/service", router);
  return request(app).post("/api/service/mail").set("x-backend-token", TOKEN).set("X-Silo", "BI").send(body);
}

describe("v517 service mail audit", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.BACKEND_SERVICE_TOKEN = TOKEN;
    process.env.MS_GRAPH_SEND_AS = "submissions@boreal.test";
    sendViaGraph.mockReset();
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
  });

  it("logs success with the mailbox used, and returns it", async () => {
    sendViaGraph.mockResolvedValue({ ok: true, messageId: "m-1" });
    const res = await sendMail({ to: "ann@acme.test", subject: "Hello", html: "<p>x</p>", sendAs: "info@boreal.test" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, messageId: "m-1", sentAs: "info@boreal.test" });
    expect(info).toHaveBeenCalledWith("[service-mail] accepted_by_microsoft", { silo: "BI", sentAs: "info@boreal.test", toDomain: "acme.test" });
  });

  it("an empty sendAs reports the fallback mailbox", async () => {
    sendViaGraph.mockResolvedValue({ ok: true });
    const res = await sendMail({ to: "ann@acme.test", subject: "Hello" });
    expect(res.body).toEqual({ ok: true, messageId: null, sentAs: "submissions@boreal.test" });
  });

  it("logs failure with the mailbox used, and returns it", async () => {
    sendViaGraph.mockResolvedValue({ ok: false, error: "graph 403" });
    const res = await sendMail({ to: "ann@acme.test", subject: "Hello", sendAs: "info@boreal.test" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: "graph 403", sentAs: "info@boreal.test" });
    expect(warn).toHaveBeenCalledWith("[service-mail] send_failed", { silo: "BI", sentAs: "info@boreal.test", toDomain: "acme.test", error: "graph 403" });
  });

  it("never logs the full recipient address", async () => {
    sendViaGraph.mockResolvedValueOnce({ ok: true, messageId: "m-1" }).mockResolvedValueOnce({ ok: false, error: "nope" });
    await sendMail({ to: "ann.secret@acme.test", subject: "Hello" });
    await sendMail({ to: "ann.secret@acme.test", subject: "Hello" });
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain("ann.secret");
    expect(logged).toContain("acme.test");
  });
});
