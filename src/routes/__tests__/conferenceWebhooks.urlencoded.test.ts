// BF_SERVER_BLOCK_vA_CONF_URLENCODED_v1 — proves the conference router parses
// urlencoded Twilio posts. Without router-level express.urlencoded, req.body
// is {} and the signature is computed over an empty body -> 403. With a VALID
// signature over the real params, the request must reach the handler (non-403).
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";

const AUTH = "test-auth-token-vA-conf-urlencoded";

describe("conferenceWebhooks urlencoded parsing", () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH;
  });

  it("does not 403 on a correctly-signed urlencoded POST to /conference/join", async () => {
    const { default: conferenceWebhooks } = await import("../conferenceWebhooks.js");
    const app = express();
    app.use("/api/webhooks/twilio", conferenceWebhooks);

    const path = "/api/webhooks/twilio/conference/join?conf=test-conf&pid=test-pid";
    const url = `https://example.com${path}`;
    const params = { CallSid: "CAxxxx", From: "client:abc", To: "client:def" };
    const signature = twilio.getExpectedTwilioSignature(AUTH, url, params);

    const res = await request(app)
      .post(path)
      .set("Content-Type", "application/x-www-form-urlencoded")
      .set("X-Forwarded-Host", "example.com")
      .set("X-Forwarded-Proto", "https")
      .set("X-Twilio-Signature", signature)
      .send(params);

    expect(res.status).not.toBe(403);
  });
});
