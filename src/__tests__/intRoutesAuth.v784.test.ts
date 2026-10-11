// BF_SERVER_v784_INT_AUTH - /api/_int/routes and /api/_int/env need a staff token;
// /build, /version and /ready stay public for health probes.
import { describe, it, expect, vi, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

vi.mock("../db.js", () => {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/FROM users WHERE id/i.test(String(sql))) {
      return { rows: [{ id: params?.[0], email: "staff@example.com", role: "Admin", silo: "BF", silos: ["BF"] }] };
    }
    return { rows: [] };
  });
  const pool = { query, connect: vi.fn() };
  return { pool, db: pool, dbQuery: query, query, default: pool };
});

const SECRET = "test-secret-int-auth-v784";
let app: express.Express;

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  const router = (await import("../routes/_int.js")).default;
  app = express();
  app.use("/api/_int", router);
});

const staffToken = () =>
  jwt.sign({ id: "11111111-1111-1111-1111-111111111111", sub: "11111111-1111-1111-1111-111111111111", role: "Admin" }, SECRET, { algorithm: "HS256", expiresIn: "5m" });

describe("/api/_int auth", () => {
  for (const path of ["/api/_int/routes", "/api/_int/env"]) {
    it(`${path} is 401 without a token`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
    });
    it(`${path} is 200 with a staff token`, async () => {
      const res = await request(app).get(path).set("Authorization", `Bearer ${staffToken()}`);
      expect(res.status).toBe(200);
    });
  }

  for (const path of ["/api/_int/build", "/api/_int/version"]) {
    it(`${path} stays public`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
    });
  }

  it("/api/_int/ready stays public (no auth gate)", async () => {
    const res = await request(app).get("/api/_int/ready");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
