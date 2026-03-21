import request from "supertest";
import type express from "express";
import type { Pool } from "pg";

const trackRequest = vi.fn();
const trackDependency = vi.fn();
const trackException = vi.fn();
const trackEvent = vi.fn();

vi.mock("../observability/appInsights", () => ({
  trackRequest: (telemetry: unknown) => trackRequest(telemetry),
  trackDependency: (telemetry: unknown) => trackDependency(telemetry),
  trackException: (telemetry: unknown) => trackException(telemetry),
  trackEvent: (telemetry: unknown) => trackEvent(telemetry),
  initializeAppInsights: vi.fn(),
}));

let app: express.Express;
let pool: Pool;

function expectRequestId(res: request.Response, requestId: string): void {
  expect(res.headers["x-request-id"]).toBe(requestId);
  if (res.body?.requestId) {
    expect(res.body.requestId).toBe(requestId);
  }
}

function expectNoStackTrace(res: request.Response): void {
  expect(res.body?.stack).toBeUndefined();
  expect(JSON.stringify(res.body)).not.toMatch(/\n\s*at /);
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-access-secret";

  vi.resetModules();
  const { buildAppWithApiRoutes } = await import("../app");
  const db = await import("../db");
  const { ensureAuditEventSchema } = await import("./helpers/auditSchema");
  const { markReady, resetStartupState } = await import("../startupState");

  app = buildAppWithApiRoutes();
  pool = db.pool;
  await ensureAuditEventSchema();
  resetStartupState();
  markReady();
});

beforeEach(() => {
  trackRequest.mockClear();
  trackDependency.mockClear();
  trackException.mockClear();
  trackEvent.mockClear();
});

afterAll(async () => {
  await pool.end();
});

describe("readiness", () => {
  it("returns 503 before readiness and 200 after markReady", async () => {
    const { resetStartupState, markReady } = await import("../startupState");
    resetStartupState();
    const requestId = "ready-wait";
    const waiting = await request(app)
      .get("/api/_int/ready")
      .set("x-request-id", requestId);

    expect(waiting.status).toBe(503);
    expect(waiting.body.ok).toBe(false);
    expect(waiting.body.code).toBe("service_not_ready");
    expectRequestId(waiting, requestId);

    markReady();
    const requestId2 = "ready-ok";
    const res = await request(app)
      .get("/api/_int/ready")
      .set("x-request-id", requestId2);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expectRequestId(res, requestId2);
    expectNoStackTrace(res);
    expect(trackDependency).not.toHaveBeenCalled();
  });
});
