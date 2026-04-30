import { describe, expect, it } from "vitest";

import { normalizeSubmissionMethod } from "../../src/repositories/lenders.repo.js";

describe("normalizeSubmissionMethod canonical allowlist", () => {
  it("maps and rejects deprecated values", () => {
    expect(normalizeSubmissionMethod("email")).toBe("EMAIL");
    expect(normalizeSubmissionMethod("GOOGLE_SHEETS")).toBe("GOOGLE_SHEET");
    expect(normalizeSubmissionMethod("MANUAL")).toBe("MANUAL");
    expect(normalizeSubmissionMethod("PORTAL")).toBeNull();
    expect(normalizeSubmissionMethod("garbage")).toBeNull();
  });
});
