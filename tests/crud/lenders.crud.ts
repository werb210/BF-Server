import { describe, it, expect } from 'vitest';
import type { Server } from "http";
import { buildAppWithApiRoutes } from "../../src/app";
import { get, patch, post } from "../_utils/http";
import { TEST_PHONE, authHeader, startOtp, verifyOtp } from "../_utils/auth";

describe("lenders CRUD", () => {
  let server: Server | null = null;
  const initialBaseUrl = process.env.TEST_BASE_URL;
  const initialBootstrapPhone = process.env.AUTH_BOOTSTRAP_ADMIN_PHONE;
  let accessToken = "";
  let lenderId = "";

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

  test("POST /api/lenders", async () => {
    const response = await post<{ id: string }>(
      "/api/lenders",
      {
        name: "Smoke Test Lender",
        country: "CA",
        submissionMethod: "email",
        submissionEmail: "submissions@smoke-lender.com",
      },
      authHeader(accessToken)
    );
    lenderId = response.id;
    expect(lenderId).toBeTruthy();
  });

  test("GET /api/lenders", async () => {
    const response = await get<Array<{ id: string }>>(
      "/api/lenders",
      authHeader(accessToken)
    );
    const lenderIds = response.map((lender) => lender.id);
    expect(lenderIds).toContain(lenderId);
  });

  test("PATCH /api/lenders/:id", async () => {
    const response = await patch<{ id: string; name?: string }>(
      `/api/lenders/${lenderId}`,
      {
        name: "Smoke Test Lender Updated",
      },
      authHeader(accessToken)
    );
    expect(response.id).toBe(lenderId);
  });
});
