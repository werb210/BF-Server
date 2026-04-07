import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOtpStateForTests } from "../app";
import { createServer } from "../server/createServer";
import { deps } from "../system/deps";

describe("server:readiness:e2e", () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer();
  });

  beforeEach(() => {
    resetOtpStateForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    deps.db.ready = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 200 from /health regardless of readiness", async () => {
    deps.db.ready = false;
    const notReady = await request(app).get("/health");
    expect(notReady.status).toBe(200);
    expect(notReady.body).toEqual({ status: "ok", data: {} });

    deps.db.ready = true;
    const ready = await request(app).get("/health");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ok", data: {} });
  });

  it("returns 503 from /ready when not ready and 200 when ready", async () => {
    deps.db.ready = false;
    const notReady = await request(app).get("/ready");
    expect(notReady.status).toBe(503);
    expect(notReady.body).toEqual({ status: "error", error: "not_ready" });

    deps.db.ready = true;
    const ready = await request(app).get("/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ok", data: {} });
  });
});
