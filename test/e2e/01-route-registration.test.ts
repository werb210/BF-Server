import request from "supertest";
import type { Express } from "express";

import { createServer } from "../../src/server/createServer";

interface RouteCheck {
  method: "get" | "post";
  path: string;
  expectedStatus: number;
  body?: Record<string, unknown>;
}

describe("Route registration and prefix integrity", () => {
  let app: Express;

  beforeAll(() => {
    app = createServer();
  });

  it("registers canonical /api routes", async () => {
    const routeChecks: RouteCheck[] = [
      { method: "get", path: "/api/health", expectedStatus: 200 },
      { method: "post", path: "/api/auth/otp/start", expectedStatus: 200, body: { phone: "+15555550100" } },
      { method: "get", path: "/api/voice/token", expectedStatus: 401 },
    ];

    for (const check of routeChecks) {
      const req = request(app)[check.method](check.path);
      const res = check.body ? await req.send(check.body) : await req;
      expect(res.status).toBe(check.expectedStatus);
    }
  });

  it("rejects legacy aliases", async () => {
    const authStart = await request(app).post("/auth/otp/start").send({ phone: "+15555550100" });
    expect(authStart.status).toBe(410);
    expect(authStart.body).toEqual({ success: false, error: "LEGACY_ROUTE_DISABLED" });

    const voiceToken = await request(app).get("/voice/token");
    expect(voiceToken.status).toBe(410);
    expect(voiceToken.body).toEqual({ success: false, error: "LEGACY_ROUTE_DISABLED" });
  });
});
