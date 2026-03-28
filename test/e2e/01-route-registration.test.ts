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

  it("registers only canonical auth and telephony prefixes", async () => {
    const routeChecks: RouteCheck[] = [
      { method: "get", path: "/health", expectedStatus: 200 },
      { method: "post", path: "/auth/otp/start", expectedStatus: 200, body: { phone: "+15555550100" } },
      { method: "get", path: "/telephony/token", expectedStatus: 401 },
    ];

    for (const check of routeChecks) {
      const req = request(app)[check.method](check.path);
      const res = check.body ? await req.send(check.body) : await req;
      expect(res.status).toBe(check.expectedStatus);
    }
  });

  it("rejects legacy route prefixes with 404", async () => {
    const malformedPaths = [
      "/api/auth/otp/start",
      "/api/telephony/token",
      "/auth/auth/otp/start",
    ];

    for (const path of malformedPaths) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, error: "not_found" });
    }
  });
});
