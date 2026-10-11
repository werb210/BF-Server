import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// BF_SERVER_MAYA_CLIENT_IDENTITY_v1 / BF_SERVER_MAYA_PROFILE_ENRICH_v1
const proxy = readFileSync(fileURLToPath(new URL("../routes/maya.ts", import.meta.url)), "utf-8");
const staff = readFileSync(fileURLToPath(new URL("../routes/mayaStaff.ts", import.meta.url)), "utf-8");

describe("maya client identity", () => {
  // BF_SERVER_MAYA_CONTEXT_v1 - the phone now comes only from the verified token
  // (services/mayaContext.ts) and travels in the signed X-Maya-Context; a caller's
  // own body.phone is dropped. Behaviour is covered in routes/__tests__/mayaIdentity.audit.test.ts.
  it("proxy derives the phone from the verified token, never the body", () => {
    expect(proxy).toContain("resolveMayaIdentity(req)");
    expect(proxy).toContain("delete b.phone;");
    expect(proxy).toContain("if (identity.phone) b.phone = identity.phone;");
    expect(proxy).toContain("JSON.stringify(fwdBody ?? {})");
  });

  it("applications-by-phone returns contact profile and business details", () => {
    expect(staff).toContain("c.name AS contact_name");
    expect(staff).toContain("c.first_name");
    expect(staff).toContain("c.company_name");
    expect(staff).toContain("c.dob");
    expect(staff).toContain("industry");
    expect(staff).toContain("yearsInBusiness");
    expect(staff).toContain("annualRevenue");
    expect(staff).toContain("contactName: contact?.contactName ?? null");
  });
});
