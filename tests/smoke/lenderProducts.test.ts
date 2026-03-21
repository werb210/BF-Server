import { describe, it, expect } from 'vitest';
import { randomUUID } from "crypto";
import { get, patch, post } from "../_utils/http";
import { authHeader, startOtp, verifyOtp } from "../_utils/auth";
import { startSmokeServer } from "./smokeServer";

describe("lender products smoke", () => {
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

  test("CRUD lender products", async () => {
    await startOtp();
    const { accessToken } = await verifyOtp();
    const headers = authHeader(accessToken);

    const lenderName = `Smoke Lender ${randomUUID()}`;
    const lender = await post<{ id: string }>(
      "/api/lenders",
      {
        name: lenderName,
        country: "US",
        submissionMethod: "api",
        apiConfig: { endpoint: "https://api.lender.test" },
      },
      headers
    );

    const requiredDocuments = [{ type: "bank_statements_6_months" }];

    const created = await post<{
      id: string;
      lenderId: string;
      active: boolean;
      required_documents: unknown;
    }>(
      "/api/lender-products",
      {
        lenderId: lender.id,
        name: "Smoke Product",
        active: false,
        required_documents: requiredDocuments,
        category: "LOC",
      },
      headers
    );

    expect(created.lenderId).toBe(lender.id);
    expect(created.active).toBe(false);
    expect(created.required_documents).toEqual([
      { type: "bank_statements_6_months", document_key: "bank_statements_6_months" },
    ]);

    const activeOnly = await get<unknown[]>(
      "/api/lender-products?active=true",
      headers
    );
    expect(Array.isArray(activeOnly)).toBe(true);

    const updatedDocs = [{ type: "government_id" }];
    const updated = await patch<{
      id: string;
      required_documents: unknown;
    }>(
      `/api/lender-products/${created.id}`,
      {
        required_documents: updatedDocs,
      },
      headers
    );

    expect(updated.required_documents).toEqual([
      { type: "government_id", document_key: "government_id" },
      { type: "bank_statements_6_months", document_key: "bank_statements_6_months" },
    ]);
  });
});
