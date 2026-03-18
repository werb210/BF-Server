import express from "express";
import request from "supertest";
import { ROLES } from "../auth/roles";
import { otpVerifyRequest } from "./helpers/otpAuth";

const trackRequest = jest.fn();
const trackDependency = jest.fn();
const trackException = jest.fn();
let idempotencyCounter = 0;
const nextIdempotencyKey = (): string => `idem-insights-${idempotencyCounter++}`;
const validConnectionString = "InstrumentationKey=00000000-0000-0000-0000-000000000000";

jest.mock("applicationinsights", () => {
  const chain = {
    setAutoCollectConsole: jest.fn().mockReturnThis(),
    setAutoCollectExceptions: jest.fn().mockReturnThis(),
    setAutoCollectPerformance: jest.fn().mockReturnThis(),
    setAutoCollectRequests: jest.fn().mockReturnThis(),
    setAutoCollectDependencies: jest.fn().mockReturnThis(),
    setSendLiveMetrics: jest.fn().mockReturnThis(),
    start: jest.fn().mockReturnThis(),
  };

  return {
    defaultClient: {
      trackRequest,
      trackDependency,
      trackException,
    },
    setup: jest.fn(() => chain),
  };
});

describe("application insights telemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    trackRequest.mockClear();
    trackDependency.mockClear();
    trackException.mockClear();
  });

  it("tracks request, dependency, and exception telemetry", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalConnectionString = process.env.APPINSIGHTS_CONNECTION_STRING;

    process.env.NODE_ENV = "production";
    process.env.APPINSIGHTS_CONNECTION_STRING = validConnectionString;

    const { initializeAppInsights } = await import(
      "../observability/appInsights"
    );

    initializeAppInsights();

    process.env.NODE_ENV = "test";

    const { requestId } = await import("../middleware/requestId");
    const { requestLogger } = await import("../middleware/requestLogger");
    const { AppError } = await import("../middleware/errors");
    const { errorHandler } = await import("../middleware/errorHandler");
    const { checkDb } = await import("../db");

    const app = express();
    app.use(requestId);
    app.use(requestLogger);
    app.get("/ok", (_req, res) => res.json({ ok: true }));
    app.get("/boom", (_req, _res, next) => {
      next(new AppError("boom", "Boom", 500));
    });
    app.use(errorHandler);

    await request(app).get("/ok").set("x-request-id", "telemetry-ok");
    expect(trackRequest).toHaveBeenCalled();

    await request(app).get("/boom").set("x-request-id", "telemetry-err");
    expect(trackException).toHaveBeenCalled();

    await checkDb();
    expect(trackDependency).toHaveBeenCalled();

    process.env.NODE_ENV = originalNodeEnv;
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.APPINSIGHTS_CONNECTION_STRING = originalConnectionString;
  });

  it("emits dependency telemetry for auth queries", async () => {
    const originalConnectionString = process.env.APPINSIGHTS_CONNECTION_STRING;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalNodeEnv = process.env.NODE_ENV;

    process.env.APPINSIGHTS_CONNECTION_STRING = validConnectionString;
    process.env.NODE_ENV = "test";

    const { initializeAppInsights } = await import(
      "../observability/appInsights"
    );
    const { buildAppWithApiRoutes } = await import("../app");
    const { createUserAccount } = await import(
      "../modules/auth/auth.service"
    );
    const { ensureAuditEventSchema } = await import("./helpers/auditSchema");

    initializeAppInsights();

    const app = buildAppWithApiRoutes();
    await ensureAuditEventSchema();
    const phone = "+14155550123";
    await createUserAccount({
      email: "telemetry-auth@example.com",
      phoneNumber: phone,
      role: ROLES.STAFF,
    });

    await otpVerifyRequest(app, {
      phone,
      idempotencyKey: nextIdempotencyKey(),
    });

    expect(trackDependency).toHaveBeenCalled();

    process.env.APPINSIGHTS_CONNECTION_STRING = originalConnectionString;
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.NODE_ENV = originalNodeEnv;
  });
});
