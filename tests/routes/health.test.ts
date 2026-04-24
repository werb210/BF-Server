import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../../src/server/createServer";

const originalEnv = { ...process.env };

describe("GET /api/health", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.mocked(global.fetch).mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.mocked(global.fetch).mockReset();
  });

  it("returns healthy maya when agent health is ok", async () => {
    process.env.MAYA_URL = "https://maya.example";
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) } as Response);

    const res = await request(createServer()).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.maya).toBeUndefined();
    expect(res.body.data).toMatchObject({
      maya: "healthy",
      env: expect.any(String),
      valid: expect.any(Boolean),
      missingRequired: expect.any(Array),
      missingOptional: expect.any(Array),
    });
  });

  it("returns degraded maya when agent health status is not ok", async () => {
    process.env.MAYA_URL = "https://maya.example";
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ status: "down" }) } as Response);

    const res = await request(createServer()).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.maya).toBeUndefined();
    expect(res.body.data?.maya).toBe("degraded");
    expect(res.body.data).toBeDefined();
  });

  it("returns degraded maya when agent health endpoint returns non-2xx", async () => {
    process.env.MAYA_URL = "https://maya.example";
    vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);

    const res = await request(createServer()).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.maya).toBeUndefined();
    expect(res.body.data?.maya).toBe("degraded");
    expect(res.body.data).toBeDefined();
  });

  it("returns degraded maya on fetch network error", async () => {
    process.env.MAYA_URL = "https://maya.example";
    vi.mocked(global.fetch).mockRejectedValue(new Error("network error"));

    const res = await request(createServer()).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.maya).toBeUndefined();
    expect(res.body.data?.maya).toBe("degraded");
    expect(res.body.data).toBeDefined();
  });

  it("times out and degrades maya when fetch hangs", async () => {
    process.env.MAYA_URL = "https://maya.example";
    vi.mocked(global.fetch).mockImplementation((_url, init: any) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });

    const started = Date.now();
    const res = await request(createServer()).get("/api/health");
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2200);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.maya).toBeUndefined();
    expect(res.body.data?.maya).toBe("degraded");
    expect(res.body.data).toBeDefined();
  }, 7000);

  it("degrades maya and does not call fetch when maya urls are missing", async () => {
    delete process.env.MAYA_URL;
    delete process.env.MAYA_SERVICE_URL;
    const fetchMock = vi.mocked(global.fetch);

    const res = await request(createServer()).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.maya).toBeUndefined();
    expect(res.body.data?.maya).toBe("degraded");
    expect(res.body.data).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
