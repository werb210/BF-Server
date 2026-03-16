import request from "supertest";
import type { Express } from "express";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getTwilioMocks } from "./helpers/twilioMocks";

function buildTestApp(): Express {
  const { buildAppWithApiRoutes } = require("../app");
  return buildAppWithApiRoutes();
}

describe("POST /api/auth/otp/start Twilio Verify behaviors", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("fails fast when TWILIO_ACCOUNT_SID is missing", () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA00000000000000000000000000000000";

    expect(() => buildTestApp()).toThrow(
      "Missing required environment variables: TWILIO_ACCOUNT_SID"
    );
  });

  it("fails fast when TWILIO_AUTH_TOKEN is missing", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxxx";
    delete process.env.TWILIO_AUTH_TOKEN;
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA00000000000000000000000000000000";

    expect(() => buildTestApp()).toThrow(
      "Missing required environment variables: TWILIO_AUTH_TOKEN"
    );
  });

  it("fails fast when TWILIO_VERIFY_SERVICE_SID is missing", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxxx";
    process.env.TWILIO_AUTH_TOKEN = "token";
    delete process.env.TWILIO_VERIFY_SERVICE_SID;

    expect(() => buildTestApp()).toThrow(
      "Missing required environment variables: TWILIO_VERIFY_SERVICE_SID"
    );
  });

  it("returns 200 when Verify succeeds", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxxx";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA00000000000000000000000000000000";

    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockResolvedValueOnce({
      sid: "VE200",
      status: "pending",
    });

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15878881837" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ sent: true });
  });

  it("creates a Twilio client per request", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxxx";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA00000000000000000000000000000000";

    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockResolvedValue({
      sid: "VE200",
      status: "pending",
    });

    const app = buildTestApp();
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15878881837" });
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15878881837" });

    expect(twilioMocks.twilioConstructor).toHaveBeenCalledTimes(1);
  });
});
