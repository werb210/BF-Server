// BF_SERVER_v63_CRM_MIRROR_ROLE
// Static check: ensure the contacts INSERT in applicationCrmMirror.ts only uses
// role values permitted by the contacts_role_check constraint defined in
// migrations/20260426_companies_contacts_partners.sql.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_ROLES = new Set(["applicant", "partner", "guarantor", "other", "unknown"]);

describe("BF_SERVER_v63_CRM_MIRROR_ROLE", () => {
  it("contacts INSERT uses an allowed role string", () => {
    const src = readFileSync(
      join(__dirname, "..", "services", "applicationCrmMirror.ts"),
      "utf8",
    );
    // Must NOT contain the old bad value.
    expect(src.includes("'applicant_primary'")).toBe(false);
    // Must contain a permitted role wrapped in single quotes immediately
    // before the now(), now() pair that closes the contacts INSERT VALUES list.
    const m = src.match(/'(applicant|partner|guarantor|other|unknown)',\s*now\(\),\s*now\(\)/);
    expect(m).not.toBeNull();
    if (m) expect(ALLOWED_ROLES.has(m[1])).toBe(true);
  });

  it("anchor present", () => {
    const src = readFileSync(
      join(__dirname, "..", "services", "applicationCrmMirror.ts"),
      "utf8",
    );
    expect(src.includes("BF_SERVER_v63_CRM_MIRROR_ROLE")).toBe(true);
  });
});
