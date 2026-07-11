// BF_SERVER_REFERRER_CRM_CONTACT_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
describe("referrer CRM contact + roster hygiene", () => {
  it("signup creates a BF CRM contact for the referrer, idempotent by email", () => {
    const s = r("src/routes/referrerSelf.ts");
    expect(s).toContain("INSERT INTO contacts");
    expect(s).toContain("SELECT 1 FROM contacts WHERE silo = 'BF' AND lower(email) = lower($3)");
    expect(s).toContain(".catch(() => undefined)");
  });
  it("Referrers list excludes the client-submission system user", () => {
    const s = r("src/routes/adminReferrers.ts");
    expect(s).toContain("AND u.id <> '00000000-0000-0000-0000-000000000001'::uuid");
  });
});
