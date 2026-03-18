import request from "supertest";
import type { Express } from "express";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getTwilioMocks } from "../helpers/twilioMocks";
import { buildAppWithApiRoutes } from "../../app";

function buildTestApp(): Express {
  return buildAppWithApiRoutes();
}

describe("POST /api/auth/otp/start", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("calls Twilio Verify with normalized E.164 phone and sms channel", async () => {
    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockResolvedValueOnce({
      sid: "VE200",
      status: "pending",
    });

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "5878881837" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({ sent: true });
    expect(typeof res.body.data.otp).toBe("string");
    expect(twilioMocks.services).toHaveBeenCalledWith(
      process.env.TWILIO_VERIFY_SERVICE_SID
    );
    expect(twilioMocks.createVerification).toHaveBeenCalledWith({
      to: "+15878881837",
      channel: "sms",
    });
  });

  it("does not crash startup when Twilio env vars are missing", () => {
    delete process.env.TWILIO_VERIFY_SERVICE_SID;

    expect(() => buildTestApp()).not.toThrow();
  });
});
