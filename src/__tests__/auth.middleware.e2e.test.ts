import request from "supertest";
import jwt from "jsonwebtoken";
import { app } from "../app";

describe("auth middleware enforcement", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
      return;
    }
    process.env.JWT_SECRET = originalSecret;
  });

  it("returns 401 NO_TOKEN when auth header is missing", async () => {
    const res = await request(app).post("/api/v1/leads").send({ leadId: "1" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ status: "error", error: "NO_TOKEN" });
  });

  it("returns success with valid JWT token", async () => {
    const token = jwt.sign({ userId: "test-user", role: "tester" }, "test-secret", {
      expiresIn: "1h",
    });

    const res = await request(app)
      .post("/api/v1/calls/start")
      .set("Authorization", `Bearer ${token}`)
      .send({ callId: "call-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", data: { started: true } });
  });
});
