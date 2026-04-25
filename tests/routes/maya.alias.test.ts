import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../../src/server/createServer.js";

const originalEnv = { ...process.env };

describe("Maya alias routes", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.mocked(global.fetch).mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.mocked(global.fetch).mockReset();
  });

  it("proxies POST /api/ai/maya/message to agent message endpoint", async () => {
    process.env.MAYA_URL = "https://maya.example";
    vi.mocked(global.fetch).mockResolvedValue({
      status: 200,
      json: async () => ({ reply: "hi" }),
    } as Response);

    const res = await request(createServer())
      .post("/api/ai/maya/message")
      .send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: "hi" });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://maya.example/api/maya/message",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("proxies POST /api/ai/maya/chat to agent chat endpoint", async () => {
    process.env.MAYA_URL = "https://maya.example";
    vi.mocked(global.fetch).mockResolvedValue({
      status: 200,
      json: async () => ({ reply: "hello" }),
    } as Response);

    const res = await request(createServer())
      .post("/api/ai/maya/chat")
      .send({ message: "hello" });

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://maya.example/api/maya/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
      })
    );
  });

  it("returns 503 maya_unavailable when MAYA_URL and MAYA_SERVICE_URL are unset", async () => {
    delete process.env.MAYA_URL;
    delete process.env.MAYA_SERVICE_URL;

    const messageRes = await request(createServer())
      .post("/api/ai/maya/message")
      .send({ message: "hi" });
    const chatRes = await request(createServer())
      .post("/api/ai/maya/chat")
      .send({ message: "hi" });

    expect(messageRes.status).toBe(503);
    expect(messageRes.body).toMatchObject({ error: "maya_unavailable" });
    expect(chatRes.status).toBe(503);
    expect(chatRes.body).toMatchObject({ error: "maya_unavailable" });
    expect(global.fetch).not.toHaveBeenCalled();
  });


  it("proxies escalate aliases and health", async () => {
    process.env.MAYA_URL = "https://maya.example";
    vi.mocked(global.fetch).mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    await request(createServer()).post("/api/ai/maya/escalate").send({ id: "1" });
    await request(createServer()).post("/api/maya/escalate").send({ id: "2" });
    await request(createServer()).get("/api/maya/health");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://maya.example/maya/escalate",
      expect.objectContaining({ method: "POST" })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "https://maya.example/health",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("returns 503 agent_proxy_error when upstream fetch rejects", async () => {
    process.env.MAYA_URL = "https://maya.example";
    vi.mocked(global.fetch).mockRejectedValue(new Error("network down"));

    const res = await request(createServer())
      .post("/api/ai/maya/message")
      .send({ message: "hi" });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "agent_proxy_error" });
  });
});
