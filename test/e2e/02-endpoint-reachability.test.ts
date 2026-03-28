import request from "supertest";
import type { Express } from "express";

import { createServer } from "../../src/server/createServer";
import { generateTestToken } from "../utils/token";

interface EndpointCheck {
  method: "get" | "post";
  path: string;
  auth?: boolean;
  body?: Record<string, unknown>;
}

describe("Endpoint reachability", () => {
  let app: Express;
  let authHeader: string;

  beforeAll(() => {
    app = createServer();
    authHeader = `Bearer ${generateTestToken()}`;
  });

  it("keeps canonical endpoints reachable (not 404)", async () => {
    const endpoints: EndpointCheck[] = [
      { method: "get", path: "/health" },
      { method: "post", path: "/auth/otp/start", body: { phone: "+15555550100" } },
      { method: "post", path: "/auth/otp/verify", body: { phone: "+15555550100", code: "654321" } },
      { method: "get", path: "/telephony/token", auth: true },
    ];

    for (const endpoint of endpoints) {
      let req = request(app)[endpoint.method](endpoint.path);
      if (endpoint.auth) {
        req = req.set("Authorization", authHeader);
      }
      const res = endpoint.body ? await req.send(endpoint.body) : await req;
      expect(res.status).not.toBe(404);
    }
  });
});
