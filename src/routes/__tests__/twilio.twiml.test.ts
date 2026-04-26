import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

describe("POST /api/webhooks/twilio/voice/twiml", () => {
  async function app() {
    const router = (await import("../webhooks.js")).default;
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use("/api/webhooks", router);
    return app;
  }

  it("dials outbound To number", async () => {
    process.env.TWILIO_CALLER_ID = "+15875550000";
    const res = await request(await app())
      .post("/api/webhooks/twilio/voice/twiml")
      .type("form")
      .send("To=%2B15875551234&outbound=1");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Dial");
    expect(res.text).toContain("+15875551234");
  });

  it("falls back to voicemail TwiML for inbound without To", async () => {
    const res = await request(await app())
      .post("/api/webhooks/twilio/voice/twiml")
      .send({});
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Record");
    expect(res.text).toContain("no agents are available");
  });
});
