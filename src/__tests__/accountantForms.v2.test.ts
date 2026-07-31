import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCOUNTANT_FORM_DOC_TYPES, isAccountantForm } from "../routes/accountant.js";

const route = readFileSync(fileURLToPath(new URL("../routes/accountant.ts", import.meta.url)), "utf-8");

describe("BF_SERVER_ACCOUNTANT_FORMS_v2", () => {
  it("uses the keys the client's renderer map actually registers", () => {
    expect(ACCOUNTANT_FORM_DOC_TYPES).toContain("cra_view_only_authorization");
    expect(ACCOUNTANT_FORM_DOC_TYPES).toContain("real_estate_collateral_disclosure");
    expect(ACCOUNTANT_FORM_DOC_TYPES).toContain("flinks_banking");
  });

  it("no longer carries the keys that were inferred from labels", () => {
    expect(ACCOUNTANT_FORM_DOC_TYPES).not.toContain("cra_authorization");
    expect(ACCOUNTANT_FORM_DOC_TYPES).not.toContain("real_estate_collateral");
    expect(ACCOUNTANT_FORM_DOC_TYPES).not.toContain("flinks_connect");
  });

  it("keeps the personal net worth statement with the applicant", () => {
    expect(isAccountantForm("net_worth_statement")).toBe(false);
  });

  it("rejects unknown and empty doc types", () => {
    expect(isAccountantForm("")).toBe(false);
    expect(isAccountantForm(null)).toBe(false);
    expect(isAccountantForm("something_else")).toBe(false);
  });

  it("guards reads with the same allow-list as writes", () => {
    expect(route).toContain("FORM_NOT_PERMITTED");
    expect(route).toContain("doc_type = ANY($2::text[])");
  });

  it("scopes every form route to the token's contact", () => {
    expect(route).toContain("ownsApplication");
    expect(route.match(/requireAccountant,/g)?.length).toBeGreaterThanOrEqual(5);
  });
});
