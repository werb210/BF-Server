// BF_SERVER_DOC_TYPE_ALIAS_GAPS_v195
import { describe, expect, it } from "vitest";
import { fetchDocumentTypeAliases, REQUIRED_DOCUMENT_KEYS } from "../requiredDocuments.js";

describe("document type aliases", () => {
  it("resolves every portal spelling of bank statements", () => {
    const aliases = fetchDocumentTypeAliases("bank_statements_6_months");
    for (const spelling of [
      "bank_statement",
      "bank_statements",
      "bank_statements_6_months",
      "six_month_bank_statements",
      "business_bank_statements",
    ]) {
      expect(aliases).toContain(spelling);
    }
  });

  it("never maps one spelling to two different canonical keys", () => {
    const owner = new Map<string, string>();
    for (const key of REQUIRED_DOCUMENT_KEYS) {
      for (const alias of fetchDocumentTypeAliases(key)) {
        const prior = owner.get(alias);
        expect(prior === undefined || prior === key).toBe(true);
        owner.set(alias, key);
      }
    }
  });

  it("includes each canonical key in its own alias list", () => {
    for (const key of REQUIRED_DOCUMENT_KEYS) {
      expect(fetchDocumentTypeAliases(key)).toContain(key);
    }
  });
});
