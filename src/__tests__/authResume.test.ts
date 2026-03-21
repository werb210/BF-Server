import { describe, it, expect } from 'vitest';
import request from "supertest";
import { buildAppWithApiRoutes } from "../app";
import { pool } from "../db";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { otpVerifyRequest } from "./helpers/otpAuth";

const app = buildAppWithApiRoutes();

let phoneCounter = 400;
const nextPhone = (): string =>
  `+1415555${String(phoneCounter++).padStart(4, "0")}`;

async function resetDb(): Promise<void> {
  await pool.query("delete from auth_refresh_tokens");
  await pool.query("delete from audit_events");
  await pool.query("delete from users");
}

beforeAll(() => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.NODE_ENV = "test";
});

beforeEach(async () => {
  await resetDb();
  phoneCounter = 400;
});

afterAll(async () => {
  await pool.end();
});

describe("auth resume flow", () => {
  it("allows refresh token replay within the grace window", async () => {
    const phone = nextPhone();
    await createUserAccount({ phoneNumber: phone, role: ROLES.STAFF });

    const login = await otpVerifyRequest(app, { phone });
    expect(login.status).toBe(200);

    const originalRefresh = login.body.refreshToken as string;

    const first = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: originalRefresh });

    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);

    const second = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: originalRefresh });

    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.refreshToken).toBe(first.body.refreshToken);
  });
});
