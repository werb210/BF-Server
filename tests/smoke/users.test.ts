import { describe, it, expect } from 'vitest';
import { randomUUID } from "crypto";
import { del, get, patch, post } from "../_utils/http";
import { authHeader, startOtp, verifyOtp } from "../_utils/auth";
import { startSmokeServer } from "./smokeServer";

describe("users smoke", () => {
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

  test("CRUD users", async () => {
    await startOtp();
    const { accessToken } = await verifyOtp();
    const headers = authHeader(accessToken);

    const email = `smoke+${randomUUID()}@example.com`;
    const created = await post<{
      ok: boolean;
      user: { id: string; email: string | null; role: string };
    }>("/api/users", { email, role: "Staff" }, headers);
    expect(created.ok).toBe(true);
    expect(created.user.email).toBe(email.toLowerCase());

    const list = await get<{ ok: boolean; users: unknown[] }>("/api/users", headers);
    expect(list.ok).toBe(true);
    expect(Array.isArray(list.users)).toBe(true);

    const updated = await patch<{ ok: boolean }>(
      `/api/users/${created.user.id}`,
      { status: "INACTIVE" },
      headers
    );
    expect(updated.ok).toBe(true);

    const deleted = await del<{ ok: boolean }>(
      `/api/users/${created.user.id}`,
      headers
    );
    expect(deleted.ok).toBe(true);
  });
});
