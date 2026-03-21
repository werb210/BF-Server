import { describe, it, expect } from 'vitest';
import express from "express";
import request from "supertest";
import {
  clientSubmissionRateLimit,
  clientReadRateLimit,
  portalRateLimit,
  resetLoginRateLimit,
} from "../middleware/rateLimit";

describe("rate limit middleware", () => {
  const originalEnv = process.env.RATE_LIMIT_ENABLED;

  afterEach(() => {
    process.env.RATE_LIMIT_ENABLED = originalEnv;
    resetLoginRateLimit();
  });

  it("returns 429 when exceeded", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    const app = express();
    app.use(express.json());
    app.post(
      "/api/client/submissions",
      clientSubmissionRateLimit(2, 1_000),
      (_req, res) => res.status(200).json({ ok: true })
    );

    await request(app).post("/api/client/submissions").send({ ok: true });
    await request(app).post("/api/client/submissions").send({ ok: true });
    const res = await request(app).post("/api/client/submissions").send({ ok: true });

    expect(res.status).toBe(429);
  });

  it("skips enforcement when disabled via env", async () => {
    process.env.RATE_LIMIT_ENABLED = "false";
    const app = express();
    app.use(express.json());
    app.post(
      "/api/client/submissions",
      clientSubmissionRateLimit(1, 1_000),
      (_req, res) => res.status(200).json({ ok: true })
    );

    const first = await request(app).post("/api/client/submissions").send({ ok: true });
    const second = await request(app).post("/api/client/submissions").send({ ok: true });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("keeps portal routes unaffected by client abuse", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    const app = express();
    app.use(express.json());
    const clientLimiter = clientSubmissionRateLimit(1, 1_000);
    const portalLimiter = portalRateLimit(1, 1_000);
    const clientReadLimiter = clientReadRateLimit(1, 1_000);

    app.post("/api/client/submissions", clientLimiter, (_req, res) =>
      res.status(200).json({ ok: true })
    );
    app.get("/api/client/lenders", clientReadLimiter, (_req, res) =>
      res.status(200).json({ ok: true })
    );
    app.get("/api/portal/applications", portalLimiter, (_req, res) =>
      res.status(200).json({ ok: true })
    );

    await request(app).post("/api/client/submissions").send({ ok: true });
    const blocked = await request(app).post("/api/client/submissions").send({ ok: true });
    const portalRes = await request(app).get("/api/portal/applications");

    expect(blocked.status).toBe(429);
    expect(portalRes.status).toBe(200);
  });
});
