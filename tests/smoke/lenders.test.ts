import { describe, it, expect } from 'vitest';
import { randomUUID } from "crypto";
import { get, post } from "../_utils/http";
import { authHeader, startOtp, verifyOtp } from "../_utils/auth";
import { startSmokeServer } from "./smokeServer";

describe("lenders smoke", () => {
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

  test("create + list lenders", async () => {
    await startOtp();
    const { accessToken } = await verifyOtp();
    const headers = authHeader(accessToken);

    const name = `Smoke Lender ${randomUUID()}`;
    const created = await post<{
      id: string;
      name: string;
      country: string;
    }>(
      "/api/lenders",
      {
        name,
        country: "US",
        submissionMethod: "api",
        apiConfig: { endpoint: "https://api.smoke.test" },
      },
      headers
    );

    expect(created.id).toBeTruthy();
    expect(created.name).toBe(name);

    const list = await get<unknown[]>("/api/lenders", headers);
    expect(Array.isArray(list)).toBe(true);

    const products = await get<{ lender: unknown; products: unknown[] }>(
      `/api/lenders/${created.id}/products`,
      headers
    );
    expect(products.lender).toBeTruthy();
    expect(Array.isArray(products.products)).toBe(true);
  });
});
