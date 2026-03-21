import { vi } from 'vitest';
import request from "supertest";
import type { Express } from "express";
import { getTwilioMocks } from "./helpers/twilioMocks";

function buildTestApp(): Express {
  const { buildAppWithApiRoutes } = require("../app");
  return buildAppWithApiRoutes();
}

describe("POST /api/auth/otp/start", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("fails fast when Verify service SID missing", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxxx";
    process.env.TWILIO_AUTH_TOKEN = "token";
    delete process.env.TWILIO_VERIFY_SERVICE_SID;
    vi.resetModules();

    expect(() => buildTestApp()).toThrow(
      "Missing required environment variables: TWILIO_VERIFY_SERVICE_SID"
    );
  });

  it("returns 204 with CORS headers on preflight", async () => {
    const app = buildTestApp();
    const res = await request(app)
      .options("/api/auth/otp/start")
      .set("Origin", "https://staff.boreal.financial")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,idempotency-key");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://staff.boreal.financial"
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-headers"]?.toLowerCase()).toContain(
      "idempotency-key"
    );
  });

  it("returns 200 when Twilio configured", async () => {
    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockResolvedValueOnce({
      sid: "VE200",
      status: "pending",
    });

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15878881337" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ sent: true });
  });

  it("returns 500 when Twilio auth invalid", async () => {
    const twilioMocks = getTwilioMocks();
    const error = new Error("Authentication failed") as Error & {
      code?: number;
      status?: number;
    };
    error.code = 20003;
    error.status = 401;
    twilioMocks.createVerification.mockRejectedValueOnce(error);

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15878881337" });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toEqual({
      code: "twilio_auth_failed",
      message: "Twilio authentication failed.",
      details: {
        twilioCode: 20003,
        twilioMessage: "Authentication failed",
      },
    });
  });
});
