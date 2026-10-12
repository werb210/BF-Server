// Marketing email failures log the SendGrid reason instead of swallowing it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql } from "./helpers/answerBySql.js";

const { queryMock, sendOne } = vi.hoisted(() => ({ queryMock: vi.fn(), sendOne: vi.fn() }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../services/sendgridService.js", async (orig) => {
  const real: any = await orig();
  return { ...real, sendgridConfigured: () => true, sendOne };
});

import marketing from "../routes/marketing.js";
import { runEmailSend } from "../services/marketingSendRunner.js";

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET!, { expiresIn: "5m" });

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([]));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: false, status: 400, error: "invalid from" });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("marketing email error logging", () => {
  it("the blast runner logs the SendGrid failure reason", async () => {
    const pool = { query: vi.fn(answerBySql([[/FROM contacts c LEFT JOIN companies co/, { rows: [{ id: "c1", email: "a@x.test", name: "A", company: null }] }]])) };
    await runEmailSend(pool as any, { silo: "BF", tag: "vip", subject: "S", html: "<p>x</p>" });
    expect(errSpy).toHaveBeenCalledWith("sendgrid_email_failed", { to: "a@x.test", status: 400, error: "invalid from" });
  });

  it("a failed test send logs the SendGrid failure reason and returns it", async () => {
    const r = await request(app).post("/api/marketing/email/send").set("Authorization", `Bearer ${token}`)
      .send({ subject: "S", html: "<p>x</p>", test: "me@x.test" });
    expect(r.body.data).toMatchObject({ test: true, ok: false, status: 400, error: "invalid from" });
    expect(errSpy).toHaveBeenCalledWith("sendgrid_test_failed", { to: "me@x.test", status: 400, error: "invalid from" });
  });

  it("a successful test send logs nothing", async () => {
    sendOne.mockResolvedValue({ ok: true, status: 202 });
    await request(app).post("/api/marketing/email/send").set("Authorization", `Bearer ${token}`)
      .send({ subject: "S", html: "<p>x</p>", test: "me@x.test" });
    expect(errSpy).not.toHaveBeenCalledWith("sendgrid_test_failed", expect.anything());
  });
});
