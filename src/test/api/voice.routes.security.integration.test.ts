import express from "express";
import request from "supertest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../middleware/auth", () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ ok: false, error: "missing_token" });
      return;
    }

    req.user = {
      userId: "9df43a22-a6f5-4f6f-9529-6484adf6b0c5",
      role: "Staff",
      silo: "default",
      siloFromToken: false,
      capabilities: [],
    };

    next();
  },
}));

import voiceTokenRouter from "../../routes/voiceToken";
import twilioVoiceRouter from "../../routes/twilioVoice";
import voiceStatusRouter from "../../routes/voiceStatus";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", voiceTokenRouter);
app.use("/api", twilioVoiceRouter);
app.use("/api", voiceStatusRouter);

function createTwilioSignature(path: string, body: Record<string, string>): string {
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  return getExpectedTwilioSignature(token, `https://voice.test${path}`, body);
}

describe("voice route hardening", () => {
  beforeAll(() => {
    process.env.TWILIO_AUTH_TOKEN = "test-auth-token-1234567890";
    process.env.TWILIO_ACCOUNT_SID = "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    process.env.TWILIO_API_KEY = "SKXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    process.env.TWILIO_API_SECRET = "test-twilio-api-secret";
    process.env.TWILIO_TWIML_APP_SID = "AP00000000000000000000000000000000";
  });

  it("returns 401 for /api/voice/token without auth", async () => {
    const res = await request(app).get("/api/voice/token");
    expect(res.status).toBe(401);
  });

  it("returns 400 for /api/voice/token with invalid identity", async () => {
    const res = await request(app)
      .get("/api/voice/token?identity=hacker_identity")
      .set("Authorization", "Bearer test");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_identity");
  });

  it("returns identity and token for /api/voice/token with valid auth", async () => {
    const res = await request(app)
      .get("/api/voice/token?identity=staff_mobile")
      .set("Authorization", "Bearer test");

    expect(res.status).toBe(200);
    expect(res.body.identity).toBe("staff_mobile");
    expect(typeof res.body.token).toBe("string");
  });

  it("returns 403 for /api/twilio/voice when signature is missing", async () => {
    const res = await request(app).post("/api/twilio/voice").type("form").send({});
    expect(res.status).toBe(403);
  });

  it("returns TwiML for /api/twilio/voice with valid signature", async () => {
    const body: Record<string, string> = {};
    const res = await request(app)
      .post("/api/twilio/voice")
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-Host", "voice.test")
      .set("X-Twilio-Signature", createTwilioSignature("/api/twilio/voice", body))
      .type("form")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.text).toContain("staff_portal");
    expect(res.text).toContain("staff_mobile");
  });

  it("returns 403 for /api/voice/status when signature is invalid", async () => {
    const res = await request(app)
      .post("/api/voice/status")
      .set("X-Twilio-Signature", "invalid")
      .type("form")
      .send({ CallSid: "CA-INVALID", CallStatus: "completed" });

    expect(res.status).toBe(403);
  });

  it("returns 200 for /api/voice/status when signature is valid", async () => {
    const body = { CallSid: "CA-STATUS-OK", CallStatus: "completed" };
    const res = await request(app)
      .post("/api/voice/status")
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-Host", "voice.test")
      .set("X-Twilio-Signature", createTwilioSignature("/api/voice/status", body))
      .type("form")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });
});
