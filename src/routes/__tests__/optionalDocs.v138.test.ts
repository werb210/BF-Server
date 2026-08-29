// BF_SERVER_OPTIONAL_DOCS_v138
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const docs = readFileSync(resolve(__dirname, "..", "clientDocumentsNeeded.ts"), "utf-8");
const appRoutes = readFileSync(
  resolve(__dirname, "..", "..", "modules", "applications", "applications.routes.ts"), "utf-8");
const v114 = readFileSync(
  resolve(__dirname, "..", "..", "..", "migrations", "2026_08_26_v114_sba_doc_set_trimmed.sql"), "utf-8");

describe("the data already said these are optional", () => {
  it.each(["sba_1919_attachments", "lease_or_loi"])("%s is required=false in the migration", (doc) => {
    expect(v114).toContain(doc);
  });

  it("v114 marked them false rather than deleting them", () => {
    expect(v114).toContain("'sba_1919_attachments', false");
    expect(v114).toContain("'lease_or_loi',         false");
  });
});

describe("an optional document no longer blocks", () => {
  it("stillNeeded excludes anything flagged required:false", () => {
    expect(docs).toContain("d.required !== false && !satisfiedNorm.has(");
  });

  it("uses !== false, so an absent flag still means required", () => {
    // Legacy rows have no flag at all. Defaulting those to optional would let a
    // genuinely mandatory document through.
    expect(docs).not.toContain("d.required === true &&");
  });

  it("keeps optional items in the full required set for staff", () => {
    expect(docs).toContain("const isRequired = !(raw && typeof raw === \"object\" && raw.required === false);");
    expect(docs).toContain("return { stillNeeded, rejected, required };");
  });
});

describe("why it mattered", () => {
  it("stillNeeded gates whether the whole application is clear", () => {
    expect(appRoutes).toContain("outstanding.stillNeeded.length === 0");
    expect(appRoutes).toContain("outstandingDocsClear");
  });

  it("the two conditional SBA docs are still labelled for the applicant", () => {
    expect(docs).toContain("Supporting detail for any Yes answer on Form 1919");
    expect(docs).toContain("only if the loan involves premises");
  });
});
