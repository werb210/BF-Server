// BF_SERVER_OTP_TEST_FIXTURES_VALID_NANP_v34 - 555-000-xxxx has an NXX of
// 000 and is not a structurally valid NANP number. Moved to the 555-01xx range
// NANPA reserves for fictional use so these survive the v33 validation.
import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../app.js";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
const app = createApp();

describe("OTP routes", () => {
  it("returns { status: ok, data: { sent: true } }", async () => {
    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550123" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.data.sent).toBe(true);
  });

  it("OTP verify returns token with sub field", async () => {
    await request(app)
      .post("/api/auth/otp/start")
      .send({ phone: "+15555550123" });

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "+15555550123", code: "000000" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.data.token).toBeDefined();

    const [, payloadB64] = res.body.data.token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

    expect(payload.sub).toBeDefined();
    expect(payload.tokenVersion).toBeDefined();
  });
});
