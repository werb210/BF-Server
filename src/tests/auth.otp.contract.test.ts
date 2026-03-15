import request from "supertest";
import app from "../../src/app";

describe("OTP start contract", () => {

  it("returns validation error when phone is missing", async () => {
    const res = await request(app).post("/api/auth/otp/start").send({});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("validation_error");
  });
  it("returns sent status on success", async () => {
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15878881837" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.sent).toBe(true);
  });
});
