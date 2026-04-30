// BF_SERVER_v67_LENDER_PRODUCT_NAME_FALLBACK
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v67_LENDER_PRODUCT_NAME_FALLBACK", () => {
  const src = readFileSync(
    join(__dirname, "..", "routes", "portalLenderProducts.ts"),
    "utf8"
  );

  it("anchor present", () => {
    expect(src).toContain("BF_SERVER_v67_LENDER_PRODUCT_NAME_FALLBACK");
  });

  it("POST handler accepts body.productName as fallback for body.name", () => {
    const idx = src.indexOf('router.post(');
    const end = src.indexOf("// PUT /api/portal/lender-products/:id", idx);
    expect(end).toBeGreaterThan(idx);
    const block = src.slice(idx, end);
    expect(block).toMatch(/typeof body\.productName === "string"/);
    expect(block).toMatch(/body\.productName\b/);
  });

  it("PUT handler accepts body.productName as fallback for body.name", () => {
    const idx = src.indexOf("// PUT /api/portal/lender-products/:id");
    const end = src.indexOf("// DELETE /api/portal/lender-products/:id", idx);
    expect(end).toBeGreaterThan(idx);
    const block = src.slice(idx, end);
    expect(block).toMatch(/typeof body\.productName === "string"/);
    expect(block).toMatch(/body\.productName\b/);
  });

  it("the validation error is still raised when neither field is present", () => {
    const occurrences = src.match(/throw new AppError\("validation_error", "name is required\.", 400\)/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});
