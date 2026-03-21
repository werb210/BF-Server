import { describe, it, expect } from 'vitest';
import type { Server } from "http";
import { buildAppWithApiRoutes } from "../../src/app";
import { get, patch, post } from "../_utils/http";
import { TEST_PHONE, authHeader, startOtp, verifyOtp } from "../_utils/auth";

describe("users CRUD", () => {
  let server: Server | null = null;
  const initialBaseUrl = process.env.TEST_BASE_URL;
  const initialBootstrapPhone = process.env.AUTH_BOOTSTRAP_ADMIN_PHONE;
  let accessToken = "";
  let userId = "";

  beforeAll(async () => {
    if (!process.env.AUTH_BOOTSTRAP_ADMIN_PHONE) {
      process.env.AUTH_BOOTSTRAP_ADMIN_PHONE = TEST_PHONE;
    }
    if (!initialBaseUrl) {
      const app = buildAppWithApiRoutes();
      await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => {
          const address = server?.address();
          if (address && typeof address === "object") {
            process.env.TEST_BASE_URL = `http://127.0.0.1:${address.port}`;
          }
          resolve();
        });
      });
    }
    await startOtp();
    const tokens = await verifyOtp();
    accessToken = tokens.accessToken;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    if (!initialBaseUrl) {
      delete process.env.TEST_BASE_URL;
    }
    if (!initialBootstrapPhone) {
      delete process.env.AUTH_BOOTSTRAP_ADMIN_PHONE;
    }
  });

  test("GET /api/users", async () => {
    const response = await get<{ ok: boolean; users: Array<{ id: string }> }>(
      "/api/users",
      authHeader(accessToken)
    );
    expect(response.ok).toBe(true);
    expect(Array.isArray(response.users)).toBe(true);
    expect(response.users.length).toBeGreaterThanOrEqual(1);
  });

  test("POST /api/users", async () => {
    const response = await post<{ user: { id: string } }>(
      "/api/users",
      {
        phone: "+15555550999",
        email: "smoke.user@test.com",
        role: "Staff",
      },
      authHeader(accessToken)
    );
    userId = response.user.id;
    expect(userId).toBeTruthy();
  });

  test("PATCH /api/users/:id", async () => {
    const response = await patch<{ ok: boolean }>(
      `/api/users/${userId}`,
      {
        first_name: "Smoke",
        last_name: "User",
      },
      authHeader(accessToken)
    );
    expect(response.ok).toBe(true);
  });

  test("POST /api/users/:id/disable", async () => {
    const response = await post<{ ok: boolean }>(
      `/api/users/${userId}/disable`,
      {},
      authHeader(accessToken)
    );
    expect(response.ok).toBe(true);
  });

  test("POST /api/users/:id/enable", async () => {
    const response = await post<{ ok: boolean }>(
      `/api/users/${userId}/enable`,
      {},
      authHeader(accessToken)
    );
    expect(response.ok).toBe(true);
  });
});
