// BF_SERVER_v791_RATE_LIMIT_KEYS - every limiter keys on rateLimitKeyFromRequest
// (right-most public X-Forwarded-For hop), so a caller rotating the left-most,
// caller-controlled entry keeps hitting the same bucket.
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { otpLimiter } from "../rateLimit.js";
import uploadFailureRouter from "../../routes/client/uploadFailure.js";

function appWith(mw: express.RequestHandler | express.Router, path: string) {
  const app = express();
  app.set("trust proxy", 1); // as in src/app.ts
  app.use(express.json());
  if (typeof (mw as any).stack !== "undefined") app.use(mw as express.Router);
  else app.post(path, mw as express.RequestHandler, (_req, res) => { res.status(204).end(); });
  return app;
}

describe("BF_SERVER_v791_RATE_LIMIT_KEYS", () => {
  it("otpLimiter (5/min): a spoofed left-most XFF entry does not reset the count", async () => {
    const app = appWith(otpLimiter, "/otp");
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post("/otp").set("X-Forwarded-For", `198.51.100.${i + 1}, 203.0.113.50:${40000 + i}`);
      expect(r.status).toBe(204);
    }
    const spoofed = await request(app).post("/otp").set("X-Forwarded-For", "8.8.8.8, 203.0.113.50:51000");
    expect(spoofed.status).toBe(429);
    // A different real caller still has its own bucket.
    const other = await request(app).post("/otp").set("X-Forwarded-For", "8.8.8.8, 203.0.113.51");
    expect(other.status).toBe(204);
  });

  it("client upload-failure limiter (60/15min): a spoofed left-most XFF entry does not reset the count", async () => {
    const app = appWith(uploadFailureRouter, "/upload-failure");
    for (let i = 0; i < 60; i++) {
      const r = await request(app).post("/upload-failure").set("X-Forwarded-For", `192.0.2.${(i % 200) + 1}, 203.0.113.60`).send({});
      expect(r.status).toBe(204);
    }
    const spoofed = await request(app).post("/upload-failure").set("X-Forwarded-For", "1.1.1.1, 203.0.113.60").send({});
    expect(spoofed.status).toBe(429);
    const other = await request(app).post("/upload-failure").set("X-Forwarded-For", "1.1.1.1, 203.0.113.61").send({});
    expect(other.status).toBe(204);
  });
});
