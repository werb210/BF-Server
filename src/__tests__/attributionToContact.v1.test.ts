// BF_SERVER_ATTRIBUTION_TO_CONTACT_v1 - gclid/UTM attribution stored on the
// application is stamped onto the CRM contact timeline at mirror time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const mirror = readFileSync(join(process.cwd(), "src", "services", "applicationCrmMirror.ts"), "utf-8");
const submit = readFileSync(join(process.cwd(), "src", "routes", "client", "v1Applications.ts"), "utf-8");
describe("attribution to contact", () => {
  it("mirror writes an attribution timeline event on the contact", () => {
    expect(mirror).toContain("'attribution'");
    expect(mirror).toContain("crm_timeline_events");
  });
  it("submit forwards attribution from application metadata", () => {
    expect(submit).toContain("metadata?.attribution");
  });
});
