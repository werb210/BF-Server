import { describe, it, expect } from 'vitest';
import axios from "axios";
import type { Server } from "http";
import { buildAppWithApiRoutes } from "../../src/app";
import { get, post } from "../_utils/http";
import {
  TEST_PHONE,
  authHeader,
  refreshToken,
  startOtp,
  verifyOtp,
} from "../_utils/auth";

describe("auth smoke", () => {
  let server: Server | null = null;
  const initialBaseUrl = process.env.TEST_BASE_URL;
  const initialBootstrapPhone = process.env.AUTH_BOOTSTRAP_ADMIN_PHONE;

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

  let accessToken = "";
  let refreshTokenValue = "";

  test("GET /health", async () => {
    const response = await get<{ ok: boolean }>("/health");
    expect(response.ok).toBe(true);
  });

  test("GET /ready", async () => {
    const response = await get<{ ok: boolean }>("/ready");
    expect(response.ok).toBe(true);
  });

  test("POST /api/auth/otp/start", async () => {
    const response = await startOtp();
    expect(response.ok).toBe(true);
  });

  test("POST /api/auth/otp/verify", async () => {
    const response = await verifyOtp();
    accessToken = response.accessToken;
    refreshTokenValue = response.refreshToken;
    expect(accessToken).toBeTruthy();
    expect(refreshTokenValue).toBeTruthy();
  });

  test("GET /api/auth/me", async () => {
    const response = await get<{ ok: boolean; role: string }>(
      "/api/auth/me",
      authHeader(accessToken)
    );
    expect(response.ok).toBe(true);
    expect(response.role).toBe("Admin");
  });

  test("POST /api/auth/refresh", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const response = await refreshToken(refreshTokenValue);
    expect(response.accessToken).toBeTruthy();
    expect(response.accessToken).not.toBe(accessToken);
  });

  test("POST /api/auth/logout", async () => {
    const response = await post<{ ok: boolean }>(
      "/api/auth/logout",
      {},
      authHeader(accessToken)
    );
    expect(response.ok).toBe(true);
  });

  test("GET /api/auth/me with old token", async () => {
    let error: unknown;

    try {
      await get("/api/auth/me", authHeader(accessToken));
    } catch (err) {
      error = err;
    }

    expect(error).toBeTruthy();
    if (axios.isAxiosError(error)) {
      expect(error.response?.status).toBe(401);
      expect(JSON.stringify(error.response?.data)).toContain("invalid_token");
    }
  });
});
