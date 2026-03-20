import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyOtpCodeMock } = vi.hoisted(() => ({
  verifyOtpCodeMock: vi.fn(),
}));

vi.mock("../src/modules/auth/otp.service", () => ({
  startOtp: vi.fn(),
  verifyOtpCode: verifyOtpCodeMock,
}));

vi.mock("../src/modules/auth/auth.routes", async () => {
  const { Router } = await import("express");
  return { default: Router() };
});

vi.mock("../src/middleware/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuthorization:
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../src/middleware/errors", () => ({
  notFoundHandler: (_req: unknown, res: { status: (code: number) => { json: (v: unknown) => void } }) =>
    res.status(404).json({ error: "not_found" }),
}));

vi.mock("../src/middleware/errorHandler", () => ({
  errorHandler: (
    _err: unknown,
    _req: unknown,
    res: { status: (code: number) => { json: (v: unknown) => void } }
  ) => res.status(500).json({ error: "internal_error" }),
}));

vi.mock("../src/routes/auth/me", () => ({
  authMeHandler: (_req: unknown, res: { json: (v: unknown) => void }) =>
    res.json({ ok: true }),
}));

vi.mock("../src/db", () => ({
  db: { query: vi.fn() },
}));

vi.mock("../src/db/migrations/createOtpSessions", () => ({
  createOtpSessionsTable: vi.fn(),
}));

import authRouter from "../src/routes/auth";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(express.text({ type: ["text/plain", "application/x-www-form-urlencoded"] }));
  app.use("/api/auth", authRouter);
  return app;
}

describe("POST /api/auth/verify-otp", () => {
  beforeEach(() => {
    verifyOtpCodeMock.mockReset();
  });

  it("accepts json payload aliases and returns invalid_code as 401", async () => {
    verifyOtpCodeMock.mockResolvedValue({ ok: false });

    const app = makeApp();
    const res = await request(app || require("../src/app").default)
      .post("/api/auth/verify-otp")
      .set("Content-Type", "application/json")
      .send({ phone: " +15551234567 ", code: " 123456 " });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_code" });
    expect(verifyOtpCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "+15551234567",
        code: "123456",
      })
    );
  });

  it("accepts form-encoded payload aliases", async () => {
    verifyOtpCodeMock.mockResolvedValue({ ok: false });

    const app = makeApp();
    const res = await request(app || require("../src/app").default)
      .post("/api/auth/verify-otp")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send("phoneNumber=%2B15551234567&otp=757064");

    expect(res.status).toBe(401);
    expect(verifyOtpCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "+15551234567",
        code: "757064",
      })
    );
  });

  it("accepts raw text body payload aliases", async () => {
    verifyOtpCodeMock.mockResolvedValue({ ok: false });

    const app = makeApp();
    const res = await request(app || require("../src/app").default)
      .post("/api/auth/verify-otp")
      .set("Content-Type", "text/plain")
      .send("mobile=%2B15551234567&token=757064");

    expect(res.status).toBe(401);
    expect(verifyOtpCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "+15551234567",
        code: "757064",
      })
    );
  });

  it("returns 400 missing_fields when fields are malformed", async () => {
    const app = makeApp();
    const res = await request(app || require("../src/app").default)
      .post("/api/auth/verify-otp")
      .set("Content-Type", "application/json")
      .send({ phone: "+15551234567" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "missing_fields" });
    expect(verifyOtpCodeMock).not.toHaveBeenCalled();
  });
});
