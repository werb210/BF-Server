import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

describe("contracts", () => {
  const app = createApp();
  it("all endpoints exist", async () => {
    const otpStart = await request(app).post("/api/auth/otp/start").send({ phone: "+15555550100" });
    expect(otpStart.status).not.toBe(404);

    const me = await request(app).get("/api/auth/me");
    expect(me.status).toBe(401);
    expect(me.body).toMatchObject({ error: "Unauthorized" });

    const callStats = await request(app).get("/api/call/stats");
    expect(callStats.status).toBe(200);

    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
  });
});
