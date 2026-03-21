import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../../app";

describe("client session refresh routing", () => {
  const app = buildAppWithApiRoutes();

  it("returns a safe null session payload for the canonical route", async () => {
    const res = await request(app).post("/api/client/session/refresh");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ session: null });
  });

  it("normalizes duplicated /api prefixes before route matching", async () => {
    const res = await request(app).post("/api/api/client/session/refresh");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ session: null });
  });

  it("allows localhost origin in non-production", async () => {
    const res = await request(app)
      .post("/api/client/session/refresh")
      .set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});
