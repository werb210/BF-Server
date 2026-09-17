// BF_SERVER_MEDIA_CATEGORY_DOCS_v328
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMediaProductCategory } from "../clientDocumentsNeeded.js";

const docs = readFileSync(resolve(__dirname, "..", "clientDocumentsNeeded.ts"), "utf-8");

describe("a media deal knows its own required documents before a lender is picked", () => {
  it("merges the media set from the application's product category, not only from a finalized product", () => {
    expect(docs).toContain("isMediaProductCategory(catRes.rows[0]?.product_category)");
    expect(docs).toContain("appendRequiredDocAll({ category: label, required: true }, seen, required)");
  });

  it("carries all five media documents", () => {
    for (const label of [
      "Budget",
      "Finance plan",
      "Tax credit status",
      "Production schedule",
      "Minimum guarantees / presales",
    ]) {
      expect(docs).toContain(`"${label}"`);
    }
  });

  it("uses the labels the Create Product modal writes, so a finalized media product dedupes instead of doubling", () => {
    expect(docs).not.toContain("Tax credit status (applying");
    expect(docs).not.toContain("Minimum guarantees / presales (if any)");
  });

  it("merges unconditionally, like the product always-required docs, not as a fallback", () => {
    const merge = docs.indexOf("isMediaProductCategory(catRes.rows[0]?.product_category)");
    const fallbackGuard = docs.indexOf("if (required.length === 0) {");
    expect(merge).toBeGreaterThan(fallbackGuard);
  });
});

describe("every spelling of the media category is recognised", () => {
  it.each(["MEDIA", "Media", "media_funding", "Media Funding", "MEDIA_FILM_FINANCE", "media-financing"])(
    "%s is media",
    (value) => {
      expect(isMediaProductCategory(value)).toBe(true);
    },
  );

  it.each(["TERM_LOAN", "EQUIPMENT_FINANCE", "", null, undefined, "MEDIATION"])("%s is not media", (value) => {
    expect(isMediaProductCategory(value as unknown)).toBe(false);
  });
});

describe("staff can see what is already in", () => {
  it("request-items reports the document types with a live upload", () => {
    expect(docs).toContain("const satisfied = await getSatisfiedDocTypes(applicationId);");
    expect(docs).toContain("return { required: raw.required, waived, forms, formsWaived, satisfied };");
  });

  it("a rejected upload does not count as satisfied", () => {
    expect(docs).toContain("d.status <> 'rejected'");
  });
});
