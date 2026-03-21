import request from "supertest";
import app from "../../src/index";

describe("OTP Verify Route", () => {
  it("should respond 200 or 400 (but not 404)", async () => {
    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "1234567890", code: "123456" });

    expect([200, 400]).toContain(res.status);
  });
});
