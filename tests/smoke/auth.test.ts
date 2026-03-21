import { describe, it, expect } from 'vitest';
import axios from "axios";
import { get, post } from "../_utils/http";
import { authHeader, startOtp, verifyOtp } from "../_utils/auth";
import { startSmokeServer } from "./smokeServer";

describe("auth smoke", () => {
  let cleanup: (() => Promise<void>) | null = null;
  const initialBootstrapPhone = process.env.AUTH_BOOTSTRAP_ADMIN_PHONE;

  beforeAll(async () => {
    if (!process.env.AUTH_BOOTSTRAP_ADMIN_PHONE) {
      process.env.AUTH_BOOTSTRAP_ADMIN_PHONE = "+15878881837";
    }
    const server = await startSmokeServer();
    cleanup = server.cleanup;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
    if (!initialBootstrapPhone) {
      delete process.env.AUTH_BOOTSTRAP_ADMIN_PHONE;
    }
  });

  test("OTP flow + auth/me", async () => {
    const start = await startOtp();
    expect(start.ok).toBe(true);

    const verify = await verifyOtp();
    expect(verify.accessToken).toBeTruthy();

    const me = await get<{ ok: boolean; role: string }>(
      "/api/auth/me",
      authHeader(verify.accessToken)
    );
    expect(me.ok).toBe(true);
    expect(me.role).toBe("Admin");
  });

  test("logout invalidates token", async () => {
    const verify = await verifyOtp();
    const logout = await post<{ ok: boolean }>(
      "/api/auth/logout",
      {},
      authHeader(verify.accessToken)
    );
    expect(logout.ok).toBe(true);

    let error: unknown;
    try {
      await get("/api/auth/me", authHeader(verify.accessToken));
    } catch (err) {
      error = err;
    }
    expect(error).toBeTruthy();
    if (axios.isAxiosError(error)) {
      expect(error.response?.status).toBe(401);
    }
  });
});
