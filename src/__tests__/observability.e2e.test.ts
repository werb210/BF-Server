import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, resetOtpStateForTests } from "../app";
import { resetMetrics } from "../system/metrics";

describe("server:observability:e2e", () => {
  const app = createApp();
  beforeEach(() => {
    resetOtpStateForTests();
    resetMetrics();
    vi.restoreAllMocks();
  });

  it("returns stable health responses", async () => {
    const withProvided = await request(app).get("/health").set("x-request-id", "rid-from-client");
    expect(withProvided.status).toBe(200);
    expect(withProvided.body).toMatchObject({ db: expect.any(Boolean), openai: expect.any(Boolean), twilio: expect.any(Boolean) });

    const withoutProvided = await request(app).get("/health");
    expect(withoutProvided.status).toBe(200);
    expect(withoutProvided.body).toMatchObject({ db: expect.any(Boolean), openai: expect.any(Boolean), twilio: expect.any(Boolean) });
  });

  it("does not require access log side effects", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns basic request/error counters from /metrics", async () => {
    await request(app).get("/health");
    await request(app).get("/health");

    const metricsResponse = await request(app).get("/metrics");
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.body.status).toBe("ok");
    expect(metricsResponse.body.data).toEqual({
      requests: 0,
      errors: 0,
    });
  });
});
