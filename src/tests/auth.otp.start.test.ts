import request from "supertest";
import type { Express } from "express";
import { vi } from "vitest";
import { buildAppWithApiRoutes } from "../app";
import { getTwilioMocks } from "../__tests__/helpers/twilioMocks";

function buildTestApp(): Express {
  return buildAppWithApiRoutes();
}

describe("POST /api/auth/otp/start phone normalization", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns 400 when phone is missing", async () => {
    const app = buildTestApp();
    const res = await request(app).post("/api/auth/otp/start").send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      ok: false,
      error: "Missing phone",
    });
  });

  it("accepts phoneNumber field", async () => {
    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockResolvedValueOnce({
      sid: "VE200",
      status: "pending",
    });

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phoneNumber: "+1 (587) 888-1837" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { sent: true } });
    expect(typeof res.body.data.otp).toBe("string");
    expect(twilioMocks.createVerification).toHaveBeenCalledWith({
      to: "+15878881837",
      channel: "sms",
    });
  });

  it("auto-normalizes 10-digit numbers to +1", async () => {
    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockResolvedValueOnce({
      sid: "VE201",
      status: "pending",
    });

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "587-888-1837" });

    expect(res.status).toBe(200);
    expect(twilioMocks.createVerification).toHaveBeenCalledWith({
      to: "+15878881837",
      channel: "sms",
    });
  });

  it("returns 200 for valid E.164 input and never 204", async () => {
    const twilioMocks = getTwilioMocks();
    twilioMocks.createVerification.mockResolvedValueOnce({
      sid: "VE202",
      status: "pending",
    });

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15878881837" });

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(204);
    expect(res.body).toMatchObject({ ok: true, data: { sent: true } });
  });
});
