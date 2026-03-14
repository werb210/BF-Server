import request from "supertest";
import type { Express } from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildAppWithApiRoutes } from "../src/app";
import { startOtp, verifyOtpCode } from "../src/modules/auth/otp.service";

vi.mock("../src/modules/auth/otp.service", () => ({
  startOtp: vi.fn(),
  verifyOtpCode: vi.fn(),
}));

vi.mock("../src/db", () => ({
  db: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

vi.mock("../src/db/migrations/createOtpSessions", () => ({
  createOtpSessionsTable: vi.fn().mockResolvedValue(undefined),
}));

function buildTestApp(): Express {
  return buildAppWithApiRoutes();
}

describe("OTP route normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("request-otp accepts 4035551234", async () => {
    vi.mocked(startOtp).mockResolvedValueOnce({ ok: true, sid: "VE123" });

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/request-otp")
      .send({ phone: "4035551234" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(startOtp).toHaveBeenCalledWith("+14035551234");
  });

  test("verify-otp accepts 4035551234", async () => {
    vi.mocked(verifyOtpCode).mockResolvedValueOnce({
      ok: true,
      token: "token",
      refreshToken: null,
      user: { id: "u1", role: "STAFF" },
    });

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: "4035551234", code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(verifyOtpCode).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "+14035551234", code: "123456" })
    );
  });

  test("invalid numbers fail", async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/request-otp")
      .send({ phone: "abc" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  test("valid OTP request returns success", async () => {
    vi.mocked(startOtp).mockResolvedValueOnce({ ok: true, sid: "VE999" });

    const app = buildTestApp();
    const res = await request(app)
      .post("/api/auth/request-otp")
      .send({ phone: "+14035551234" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
