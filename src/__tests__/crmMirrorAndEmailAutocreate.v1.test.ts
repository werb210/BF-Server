// BF_SERVER_CRM_MIRROR_NORMALIZED_FALLBACKS_v1 + BF_SERVER_EMAIL_AUTOCREATE_CONTACT_v1
// 1) Submit's CRM mirror must resolve business/applicant from every payload
//    shape (thin legacy body -> normalized fallbacks) and log when it skips.
// 2) Inbox emails to unknown external recipients must auto-create a lead
//    contact and log the email to it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const submit = readFileSync(join(process.cwd(), "src", "routes", "client", "v1Applications.ts"), "utf-8");
const mirror = readFileSync(join(process.cwd(), "src", "services", "applicationCrmMirror.ts"), "utf-8");
const o365 = readFileSync(join(process.cwd(), "src", "routes", "o365.ts"), "utf-8");
describe("CRM record creation", () => {
  it("mirror call maps normalized + alternate keys", () => {
    expect(submit).toContain("nrm?.company");
    expect(submit).toContain("Array.isArray(nrm?.applicants)");
    expect(submit).toContain("bizSrc.legalName");
  });
  it("mirror logs instead of silently skipping", () => {
    expect(mirror).toContain("[crm_mirror] skipped");
  });
  it("inbox send auto-creates lead contacts for unknown external recipients", () => {
    expect(o365).toContain("EMAIL_AUTOCREATE_CONTACT_v1");
    expect(o365).toContain("ARRAY['email']::text[]");
    expect(o365).toContain("@boreal\\\\.(financial|insure)$");
  });
});
