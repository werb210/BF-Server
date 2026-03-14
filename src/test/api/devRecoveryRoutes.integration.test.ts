import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { buildApp } from "../../app";
import devRecoveryRoutes from "../../routes/devRecoveryRoutes";

describe("dev recovery routes", () => {
  it("serves readiness endpoint payload", async () => {
    const app = express();
    app.use(express.json());
    app.use(devRecoveryRoutes);

    const res = await request(app).get("/api/dev/ready");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      service: "bf-server",
      mode: "development",
    });
  });

  it("serves temporary telephony token payload", async () => {
    const app = express();
    app.use(express.json());
    app.use(devRecoveryRoutes);

    const res = await request(app).get("/telephony/token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: "dev-token",
      identity: "dev-user",
    });
  });

  it("allows cross-origin requests with credentials", async () => {
    const app = buildApp();
    const origin = "http://localhost:5173";

    const res = await request(app)
      .options("/api/dev/ready")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
