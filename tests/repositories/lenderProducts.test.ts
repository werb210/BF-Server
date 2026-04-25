import { describe, expect, it, vi } from "vitest";

import {
  createLenderProduct,
  listLenderProducts,
  normalizeRateType,
} from "../../src/repositories/lenderProducts.repo.js";

describe("normalizeRateType", () => {
  it("normalizes and validates expected enum values", () => {
    expect(normalizeRateType("fixed")).toBe("FIXED");
    expect(normalizeRateType("VARIABLE")).toBe("VARIABLE");
    expect(normalizeRateType(" Fixed ")).toBe("FIXED");
    expect(normalizeRateType("invalid")).toBeNull();
    expect(normalizeRateType(null)).toBeNull();
    expect(normalizeRateType(undefined)).toBeNull();
  });
});

describe("createLenderProduct", () => {
  it("inserts rate_type as uppercase enum value", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ column_name: "id" }, { column_name: "lender_id" }, { column_name: "name" }, { column_name: "active" }, { column_name: "country" }, { column_name: "rate_type" }, { column_name: "interest_min" }, { column_name: "interest_max" }, { column_name: "term_min" }, { column_name: "term_max" }, { column_name: "term_unit" }, { column_name: "category" }, { column_name: "type" }, { column_name: "required_documents" }, { column_name: "amount_min" }, { column_name: "amount_max" }, { column_name: "silo" }, { column_name: "created_at" }, { column_name: "updated_at" }] })
      .mockResolvedValueOnce({ rows: [{ id: "prod-id" }] });

    await createLenderProduct({
      lenderId: "lender-id",
      name: "Product A",
      active: true,
      category: "LOC",
      requiredDocuments: [],
      rateType: "fixed",
      client: { query },
    });

    const insertValues = query.mock.calls[1][1] as unknown[];
    expect(insertValues).toContain("FIXED");
    expect(insertValues).not.toContain("fixed");
  });
});


describe("listLenderProducts", () => {
  it("includes amount_min and amount_max keys", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [
        { column_name: "id" },
        { column_name: "lender_id" },
        { column_name: "name" },
        { column_name: "active" },
        { column_name: "category" },
        { column_name: "country" },
        { column_name: "rate_type" },
        { column_name: "interest_min" },
        { column_name: "interest_max" },
        { column_name: "term_min" },
        { column_name: "term_max" },
        { column_name: "term_unit" },
        { column_name: "amount_min" },
        { column_name: "amount_max" },
        { column_name: "required_documents" },
        { column_name: "created_at" },
        { column_name: "updated_at" },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: "p1", amount_min: 100, amount_max: 200 }] });

    const rows = await listLenderProducts({ query } as any);
    expect(rows[0]).toHaveProperty("amount_min");
    expect(rows[0]).toHaveProperty("amount_max");
  });
});
