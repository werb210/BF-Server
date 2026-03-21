import { describe, it, expect } from 'vitest';
import type { Server } from "http";
import { buildAppWithApiRoutes } from "../../src/app";
import { del, get, patch, post } from "../_utils/http";
import { TEST_PHONE, authHeader, startOtp, verifyOtp } from "../_utils/auth";

describe("lender products CRUD", () => {
  let server: Server | null = null;
  const initialBaseUrl = process.env.TEST_BASE_URL;
  const initialBootstrapPhone = process.env.AUTH_BOOTSTRAP_ADMIN_PHONE;
  let accessToken = "";
  let lenderId = "";
  let productId = "";
  let requirementId = "";

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

    const lender = await post<{ id: string }>(
      "/api/lenders",
      {
        name: "Smoke Test Lender Products",
        country: "CA",
        submissionMethod: "email",
        submissionEmail: "submissions@smoke-lender.com",
      },
      authHeader(accessToken)
    );
    lenderId = lender.id;
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

  test("POST /api/lender-products", async () => {
    const response = await post<{ id: string }>(
      "/api/lender-products",
      {
        lenderId,
        name: "Smoke Product",
        category: "LOC",
        term_min: 6,
        term_max: 24,
      },
      authHeader(accessToken)
    );
    productId = response.id;
    expect(productId).toBeTruthy();
  });

  test("GET /api/lender-products", async () => {
    const response = await get<Array<{ id: string }>>(
      "/api/lender-products",
      authHeader(accessToken)
    );
    const productIds = response.map((product) => product.id);
    expect(productIds).toContain(productId);
  });

  test("PATCH /api/lender-products/:id", async () => {
    const response = await patch<{ id: string }>(
      `/api/lender-products/${productId}`,
      {
        name: "Smoke Product Updated",
        term_min: 9,
        term_max: 36,
      },
      authHeader(accessToken)
    );
    expect(response.id).toBe(productId);
  });

  test("POST /api/lender-products/:id/requirements", async () => {
    const response = await post<{ requirement: { id: string } }>(
      `/api/lender-products/${productId}/requirements`,
      {
        document_type: "bank_statement",
        required: true,
      },
      authHeader(accessToken)
    );
    requirementId = response.requirement.id;
    expect(requirementId).toBeTruthy();
  });

  test("DELETE /api/lender-products/:id/requirements/:reqId", async () => {
    const response = await del<{ requirement: { id: string } }>(
      `/api/lender-products/${productId}/requirements/${requirementId}`,
      authHeader(accessToken)
    );
    expect(response.requirement.id).toBe(requirementId);
  });
});
