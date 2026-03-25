import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../app";

describe("server:contract:e2e", () => {
  it("rejects invalid otp verify payload", async () => {
    const res = await request(app)
      .post("/auth/otp/verify")
      .send({}); // invalid

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects missing auth on telephony", async () => {
    const res = await request(app)
      .get("/telephony/token");

    expect(res.status).toBe(401);
  });

  it("full flow works", async () => {
    await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+61400000000" });

    const verify = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+61400000000", code: "000000" });

    expect(verify.body.token).toBeTruthy();

    const tel = await request(app)
      .get("/telephony/token")
      .set("Authorization", `Bearer ${verify.body.token}`);

    expect(tel.body.token).toBeTruthy();
  });
});
