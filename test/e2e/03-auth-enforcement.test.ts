import request from "supertest";
import type { Express } from "express";

import { createServer } from "../../src/server/createServer";
import { generateTestToken } from "../utils/token";

describe("Auth enforcement", () => {
  let app: Express;

  beforeAll(() => {
    app = createServer();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await request(app).get("/telephony/token");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: "No token" });
  });

  it("returns 200 with valid token", async () => {
    const token = generateTestToken();

    const res = await request(app)
      .get("/telephony/token")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe("string");
  });

  it("returns 401 for invalid token", async () => {
    const res = await request(app)
      .get("/telephony/token")
      .set("Authorization", "Bearer invalid-token");

    expect(res.status).toBe(401);
  });
});
