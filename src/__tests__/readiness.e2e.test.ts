import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, resetOtpStateForTests } from "../app";
import { deps } from "../system/deps";

describe("server:readiness:e2e", () => {
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
    expect(notReady.body).toEqual({ status: "ok" });

    deps.db.ready = true;
    const ready = await request(app).get("/health");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ok" });
  });

  it("returns 503 from /ready when not ready and 200 when ready", async () => {
    deps.db.ready = false;
    const notReady = await request(app).get("/ready");
    expect(notReady.status).toBe(503);
    expect(notReady.body).toEqual({ status: "not_ready" });

    deps.db.ready = true;
    const ready = await request(app).get("/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ok" });
  });
});
