// BF_SERVER_APPLICANT_ACTION_CENTER_v197
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const svc = readFileSync("src/services/applicantActions.ts", "utf-8");
const route = readFileSync("src/routes/clientDocumentsNeeded.ts", "utf-8");

describe("applicant action center", () => {
  it("treats a rejected document as outstanding even when an upload exists", () => {
    expect(svc).toContain("if (rejected.has(category) || !uploaded.has(category)) outstanding.push(item)");
  });

  it("surfaces a rejected document whose requirement was since removed", () => {
    expect(svc).toMatch(/for \(const category of rejected\)[\s\S]{0,200}required\.includes\(category\)/);
  });

  it("puts rejected items at the top of the list", () => {
    expect(svc).toContain("Number(b.urgent) - Number(a.urgent)");
  });

  it("only lists forms this application was actually asked for", () => {
    expect(svc).toMatch(/if \(!asked\.some\(\(d\) => task\.match\.test\(d\)\)\) continue;/);
  });

  it("uses the same task keys v778 already stores on live messages", () => {
    for (const key of ["cra", "networth", "advisors", "debt", "equipment", "realestate", "flinks"]) {
      expect(svc).toContain(`key: "${key}"`);
    }
  });

  it("never lets a failed lookup throw on the applicant home screen", () => {
    expect(svc.match(/\.catch\(\(\) => \(\{ rows: \[\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("excludes soft-deleted documents from both counts", () => {
    expect(svc.match(/deleted_at IS NULL/g)?.length).toBe(3);
  });
});

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
