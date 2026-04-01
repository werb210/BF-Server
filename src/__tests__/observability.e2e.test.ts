import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, resetOtpStateForTests } from "../app";
import { resetMetrics } from "../system/metrics";

describe("server:observability:e2e", () => {
  beforeEach(() => {
    resetOtpStateForTests();
    resetMetrics();
    vi.restoreAllMocks();
  });

  it("sets x-request-id on all responses and preserves provided request id", async () => {
    const provided = "rid-from-client";

    const withProvided = await request(app).get("/health").set("x-request-id", provided);
    expect(withProvided.status).toBe(200);
    expect(withProvided.headers["x-request-id"]).toBe(provided);

    const withoutProvided = await request(app).get("/health");
    expect(withoutProvided.status).toBe(200);
    expect(typeof withoutProvided.headers["x-request-id"]).toBe("string");
    expect(withoutProvided.headers["x-request-id"]).toHaveLength(36);
  });

  it("writes structured JSON access logs", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);

    expect(spy).toHaveBeenCalled();
    const first = spy.mock.calls[0]?.[0];
    expect(typeof first).toBe("string");

    const entry = JSON.parse(String(first)) as Record<string, unknown>;
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("request");
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/health");
    expect(entry.status).toBe(200);
    expect(typeof entry.rid).toBe("string");
  });

  it("returns basic request/error counters from /metrics", async () => {
    await request(app).get("/health");
    await request(app).get("/health");

    const metricsResponse = await request(app).get("/metrics");
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.body).toEqual({
      requests: 3,
      errors: 0,
    });
  });
});
