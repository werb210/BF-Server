import { describe, expect, it } from "vitest";

import { normalizeSubmissionMethod } from "../../src/repositories/lenders.repo.js";

describe("normalizeSubmissionMethod", () => {
  it("normalizes and validates allowed values", () => {
    expect(normalizeSubmissionMethod("email")).toBe("EMAIL");
    expect(normalizeSubmissionMethod("Email")).toBe("EMAIL");
    expect(normalizeSubmissionMethod("API")).toBe("API");
    expect(normalizeSubmissionMethod("xyz")).toBeNull();
    expect(normalizeSubmissionMethod(null)).toBeNull();
    expect(normalizeSubmissionMethod(undefined)).toBeNull();
  });
});
