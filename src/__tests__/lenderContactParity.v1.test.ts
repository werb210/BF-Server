// BF_SERVER_LENDER_CONTACT_SYNC_v3 / BF_SERVER_LENDER_EDIT_ADDRESS_v1
// Parity between the staff lender form (primary_contact_*) and the lender
// portal profile (contact_*), and write-through of address + main phone on
// the staff PATCH path (previously silently dropped).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const lenderSelf = readFileSync(join(process.cwd(), "src", "routes", "lenderSelf.ts"), "utf-8");
const portalLenders = readFileSync(join(process.cwd(), "src", "routes", "portalLenders.ts"), "utf-8");
const repo = readFileSync(join(process.cwd(), "src", "repositories", "lenders.repo.ts"), "utf-8");

describe("lender contact parity", () => {
  it("lender profile prefers staff-edited primary_contact_name/email", () => {
    expect(lenderSelf).toContain("COALESCE(NULLIF(primary_contact_name, ''), contact_name) AS contact_name");
    expect(lenderSelf).toContain("COALESCE(NULLIF(primary_contact_email, ''), contact_email) AS contact_email");
  });
  it("lender edits sync back to primary_contact_* columns", () => {
    expect(lenderSelf).toContain("BF_SERVER_LENDER_CONTACT_SYNC_v3");
    expect(lenderSelf).toContain('contact_name: "primary_contact_name"');
    expect(lenderSelf).toContain('contact_email: "primary_contact_email"');
  });
  it("lender profile PATCH accepts country", () => {
    expect(lenderSelf).toContain("country: str(body.country)");
  });
});

describe("staff lender PATCH address write-through", () => {
  it("portalLenders PATCH forwards address + main phone", () => {
    expect(portalLenders).toContain("BF_SERVER_LENDER_EDIT_ADDRESS_v1");
    expect(portalLenders).toContain("postal_code: body.postalCode ?? body.postal_code");
  });
  it("updateLender repo writes address + main phone columns", () => {
    expect(repo).toContain('updates.push({ name: "street", value: params.street });');
    expect(repo).toContain('updates.push({ name: "phone", value: params.phone });');
  });
});
