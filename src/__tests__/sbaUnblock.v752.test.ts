// BF_SERVER_LEASE_OPTIONAL_v752 / BF_SERVER_SBA_FORMS_SCOPE_v752 / BF_SERVER_SEND_REASON_v752 / BF_SERVER_SBA_LOG_ONCE_v752
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isAlwaysOptionalDoc } from "../routes/clientDocumentsNeeded.js";
import { shouldLogBlocked } from "../signnow/sba/sbaSigning.js";

describe("lease or letter of intent is optional", () => {
  it("by key or by its label, from any list", () => {
    expect(isAlwaysOptionalDoc("lease_or_loi")).toBe(true);
    expect(isAlwaysOptionalDoc("Lease or letter of intent - only if the loan involves premises")).toBe(true);
    expect(isAlwaysOptionalDoc("owner_photo_id")).toBe(false);
    expect(isAlwaysOptionalDoc("Lease agreement (if applicable)")).toBe(false);
  });
  it("stays required when staff request it from Request Items", () => {
    const s = readFileSync("src/routes/clientDocumentsNeeded.ts", "utf8");
    expect(s).toContain("(forced || !isAlwaysOptionalDoc(docType))");
    expect(s).toContain("{ category: row.document_type, required: true, forceRequired: true }");
  });
});

describe("SBA forms list is scoped to the application", () => {
  it("takes the product category from the application when only application_id is sent", () => {
    const s = readFileSync("src/routes/lenderProductsRequiredDocs.ts", "utf8");
    expect(s).toContain("SELECT product_category FROM applications WHERE id::text = ($1)::text LIMIT 1");
    expect(s).toContain("normalizeProductCategoryForFilter(categoryRaw)");
  });
});

describe("send says what is missing", () => {
  it("separate reasons for an unsigned application and an unsubmitted credit summary", () => {
    const s = readFileSync("src/services/submission/orchestrator.ts", "utf8");
    expect(s).toContain('return { fired: false, reason: "application_not_signed" }');
    expect(s).toContain('return { fired: false, reason: "credit_summary_not_submitted" }');
  });
});

describe("blocked SBA dispatch is logged once per six hours", () => {
  it("throttles by application and owner", () => {
    expect(shouldLogBlocked("a:1", 1_000)).toBe(true);
    expect(shouldLogBlocked("a:1", 1_000 + 5 * 60_000)).toBe(false);
    expect(shouldLogBlocked("a:2", 1_000)).toBe(true);
    expect(shouldLogBlocked("a:1", 1_000 + 6 * 3_600_000 + 1)).toBe(true);
  });
});

// BF_SERVER_SIGNED_APP_FILED_v752
import { fileSignedApplicationDocument } from "../signnow/finalizeSignedApplication.js";
describe("the signed application is filed under Documents", () => {
  const stored = { blobName: "app/signed.pdf", url: "https://blob/app/signed.pdf", sizeBytes: 1234, hash: "abc" };
  it("inserts one accepted system document", async () => {
    const inserts: unknown[][] = [];
    const q = async (sql: string, params: unknown[]) => {
      if (/^\s*SELECT id::text AS id FROM documents/.test(sql)) return { rows: [] };
      if (/INSERT INTO documents/.test(sql)) { inserts.push(params); return { rows: [] }; }
      throw new Error("unexpected sql " + sql);
    };
    expect(await fileSignedApplicationDocument("app-1", stored, q)).toEqual({ filed: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual(expect.arrayContaining(["app-1", "Signed-Application-app-1.pdf", "abc", "app/signed.pdf", 1234, "signed_application"]));
  });
  it("does not file it twice", async () => {
    const q = async (sql: string) => (/SELECT id::text AS id FROM documents/.test(sql) ? { rows: [{ id: "d1" }] } : (() => { throw new Error("no insert expected"); })());
    expect(await fileSignedApplicationDocument("app-1", stored, q as any)).toEqual({ filed: false, reason: "already_filed" });
  });
});
