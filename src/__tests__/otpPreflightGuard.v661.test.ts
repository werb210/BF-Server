// BF_SERVER_BLOCK_v661 - OTP preflight guard
import request from "supertest";
import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";

const app = createApp();
const ORIGIN = "https://staff.boreal.financial";

describe("v661 OTP preflight guard", () => {
  it("answers OPTIONS for /api/auth/* with 204 and the CORS headers", async () => {
    const r = await request(app)
      .options("/api/auth/otp/start")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(r.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(r.headers["access-control-allow-methods"])).toContain("POST");
  });

  it("does not hand a disallowed origin the CORS headers", async () => {
    const r = await request(app)
      .options("/api/auth/otp/start")
      .set("Origin", "https://evil.example.com")
      .set("Access-Control-Request-Method", "POST");
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a preflight before the json body parser can reject it", async () => {
    // A malformed JSON body on a preflight would be a 400 if express.json ran first.
    for (const path of ["/api/auth/otp/verify", "/api/client/messages"]) {
      const r = await request(app)
        .options(path)
        .set("Origin", ORIGIN)
        .set("Access-Control-Request-Method", "POST")
        .set("Content-Type", "application/json")
        .send("{not json");
      expect(r.status).toBe(204);
      expect(r.headers["access-control-allow-origin"]).toBe(ORIGIN);
    }
  });
});
