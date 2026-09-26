// BF_SERVER_APPLICANT_ACTION_CENTER_v197 (route checks; service rules moved to v544 test)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync("src/routes/clientDocumentsNeeded.ts", "utf-8");

describe("route", () => {
  it("rejects a malformed application id before touching the database", () => {
    expect(route).toContain('invalid_application_id');
    expect(route).toMatch(/\/\^\[0-9a-f-\]\{36\}\$\/i\.test\(applicationId\)/);
  });
  it("enforces the same ownership check as the docs-needed route", () => {
    expect(route).toContain("callerOwnsApplication");
    expect(route).toMatch(/owns\)[\s\S]{0,60}403/);
  });
});
