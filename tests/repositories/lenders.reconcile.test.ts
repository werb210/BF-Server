import { describe, expect, it } from "vitest";

import { reconcileSubmissionPayload } from "../../src/repositories/lenders.repo.js";

describe("reconcileSubmissionPayload", () => {
  it("reconciles method-specific payload fields", () => {
    const cases = [
      {
        input: { method: "MANUAL", email: "x@y.com", apiConfig: { endpoint: "x" }, submissionConfig: { sheetId: "1" } },
        expected: { method: "MANUAL", email: null, apiConfig: null, submissionConfig: null },
      },
      {
        input: { method: "EMAIL", email: "ops@example.com", apiConfig: { endpoint: "x" }, submissionConfig: { sheetId: "1" } },
        expected: { method: "EMAIL", email: "ops@example.com", apiConfig: null, submissionConfig: null },
      },
      {
        input: { method: "API", email: "ops@example.com", apiConfig: { endpoint: "https://api.test" }, submissionConfig: { sheetId: "1" } },
        expected: { method: "API", email: null, apiConfig: { endpoint: "https://api.test" }, submissionConfig: null },
      },
      {
        input: { method: "GOOGLE_SHEET", email: "ops@example.com", apiConfig: { endpoint: "x" }, submissionConfig: { sheetId: "sheet-1" } },
        expected: { method: "GOOGLE_SHEET", email: null, apiConfig: null, submissionConfig: { sheetId: "sheet-1" } },
      },
      {
        input: { method: "EMAIL", email: null, apiConfig: null, submissionConfig: null },
        expected: { method: null, email: null, apiConfig: null, submissionConfig: null },
      },
    ] as const;

    for (const item of cases) {
      expect(reconcileSubmissionPayload(item.input)).toEqual(item.expected);
    }
  });
});
