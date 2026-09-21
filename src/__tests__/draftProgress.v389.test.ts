// BF_SERVER_DRAFT_PROGRESS_v389
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applicantIdentity, furthestStep } from "../services/draftProgress.js";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("furthest step", () => {
  it("never goes down when the applicant steps back", () => {
    expect(furthestStep({ currentStep: 4 }, { currentStep: 2 })).toBe(4);
    expect(furthestStep({ furthestStep: 5, currentStep: 3 }, { currentStep: 3 })).toBe(5);
    expect(furthestStep({}, { currentStep: 2 })).toBe(2);
  });
  it("ignores junk", () => {
    expect(furthestStep({ currentStep: "x" }, { currentStep: 99 })).toBe(0);
  });
});

describe("applicant identity from Step 4", () => {
  it("reads first/last/email and tidies them", () => {
    expect(applicantIdentity({ firstName: " Ann ", lastName: "Smith", email: "ANN@acme.com " })).toEqual({ first: "Ann", last: "Smith", email: "ann@acme.com" });
  });
  it("falls back to fullName and drops a bad email", () => {
    expect(applicantIdentity({ fullName: "Mary Ann Lee", email: "nope" })).toEqual({ first: "Mary", last: "Ann Lee", email: "" });
  });
  it("returns null when nothing was typed", () => {
    expect(applicantIdentity({})).toBeNull();
    expect(applicantIdentity(null)).toBeNull();
  });
});

describe("wiring", () => {
  it("the draft save records the furthest step and fills the contact", () => {
    const v1 = read("src/routes/client/v1Applications.ts");
    expect(v1).toContain("nextMetadata.furthestStep = reached");
    expect(v1).toContain("await fillDraftContact(applicationId, nextMetadata.applicant as any);");
  });
  it("only the OTP placeholder name is replaced, and only a blank email filled", () => {
    const svc = read("src/services/draftProgress.ts");
    expect(svc).toContain('const PLACEHOLDER_FIRST = "Unknown";');
    expect(svc).toContain('const PLACEHOLDER_LAST = "(application started)";');
    expect(svc).toContain("AND NULLIF(btrim(c.email), '') IS NULL");
  });
  it("marketing and dashboard funnels read the furthest step", () => {
    const expr = "GREATEST(NULLIF(metadata->>'furthestStep','')::int, NULLIF(metadata->>'currentStep','')::int)";
    expect(read("src/routes/dashboard.ts").split(expr).length - 1).toBe(2);
    const mk = read("src/routes/marketing.ts");
    expect(mk).toContain(expr);
    expect(mk).toContain("GREATEST(NULLIF(a.metadata->>'furthestStep','')::int, NULLIF(a.metadata->>'currentStep','')::int)");
  });
});
