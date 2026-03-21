import { describe, it, expect } from 'vitest';
import jwt from "jsonwebtoken";
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";

const app = buildAppWithApiRoutes();

async function resetDb(): Promise<void> {
  await pool.query("delete from users");
}

beforeAll(() => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

describe("auth expiry handling", () => {
  it("returns 401 on expired access token", async () => {
    const user = await createUserAccount({
      phoneNumber: "+14155559999",
      role: ROLES.STAFF,
    });

    const expiredToken = jwt.sign(
      { sub: user.id, role: ROLES.STAFF, tokenVersion: 0 },
      process.env.JWT_SECRET as string,
      {
        algorithm: "HS256",
        expiresIn: "-10s",
        issuer: "boreal-staff-server",
        audience: "boreal-staff-portal",
      }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("invalid_token");
  });
});
