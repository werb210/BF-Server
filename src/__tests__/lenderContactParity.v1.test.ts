// BF_SERVER_LENDER_CONTACT_SYNC_v3 / BF_SERVER_LENDER_EDIT_ADDRESS_v1 /
// BF_SERVER_LENDER_COMPANY_PARITY_v1 / BF_SERVER_LENDER_PRODUCT_PARITY_v1 /
// BF_SERVER_LENDER_PRODUCT_NOTIFY_v1
// Staff form <-> lender portal field parity (company + products; commission
// stays staff-only) and staff notification on lender product create/update.
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
  it("lender profile returns and accepts the staff-form field set", () => {
    expect(lenderSelf).toContain("application_url, announcement, submission_method, submission_email");
    expect(lenderSelf).toContain("application_url: str(body.application_url)");
    expect(lenderSelf).toContain("submission_email: str(body.submission_email)");
    expect(lenderSelf).toContain("country: str(body.country)");
  });
});

describe("staff lender PATCH write-through", () => {
  it("portalLenders PATCH forwards address, phone, description", () => {
    expect(portalLenders).toContain("BF_SERVER_LENDER_EDIT_ADDRESS_v1");
    expect(portalLenders).toContain("postal_code: body.postalCode ?? body.postal_code");
    expect(portalLenders).toContain("description: body.description,");
  });
  it("updateLender repo writes address, phone, description columns", () => {
    expect(repo).toContain('updates.push({ name: "street", value: params.street });');
    expect(repo).toContain('updates.push({ name: "phone", value: params.phone });');
    expect(repo).toContain('updates.push({ name: "description", value: params.description });');
  });
});

describe("lender product parity", () => {
  it("lender products GET returns required_documents", () => {
    expect(lenderSelf).toContain("eligibility_notes,\n              required_documents");
  });
  it("lender product create/update accept active + required_documents", () => {
    expect(lenderSelf).toContain("BF_SERVER_LENDER_PRODUCT_PARITY_v1");
    expect(lenderSelf).toContain("active = COALESCE($17, active)");
    expect(lenderSelf).toContain("required_documents = COALESCE($18::jsonb, required_documents)");
  });
});

describe("lender product notifications", () => {
  it("create and update both notify staff with a product deep link", () => {
    expect(lenderSelf).toContain("BF_SERVER_LENDER_PRODUCT_NOTIFY_v1");
    expect(lenderSelf.split("notifyStaffOfProductChange(").length - 1).toBeGreaterThanOrEqual(3);
    expect(lenderSelf).toContain("/lenders?editProduct=");
    expect(lenderSelf).toContain("notifyAllStaff");
  });
});
