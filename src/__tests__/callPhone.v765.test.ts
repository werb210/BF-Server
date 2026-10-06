// BF_SERVER_CALL_PHONE_v765
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { firstPhone } from "../modules/applications/applications.routes.js";

describe("the number the portal dials for Call client", () => {
  it("takes the first value that is a real phone number", () => {
    expect(firstPhone("+1 403 555 0199", "4035550111")).toBe("+1 403 555 0199");
    expect(firstPhone(null, "", "12", "403-555-0111")).toBe("403-555-0111");
    expect(firstPhone(undefined, null)).toBeNull();
  });
  it("the details endpoint puts the CRM contact's phone first", () => {
    const src = readFileSync("src/modules/applications/applications.routes.ts", "utf8");
    expect(src).toContain("(SELECT c.phone FROM contacts c WHERE c.id = a.contact_id) AS contact_phone");
    expect(src).toContain("callPhone: firstPhone(app.contact_phone,");
  });
});
