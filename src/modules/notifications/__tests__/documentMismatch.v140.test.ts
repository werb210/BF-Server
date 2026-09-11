import { describe, it, expect } from "vitest";
import { buildDocumentMismatchNotification } from "../ocrNotifications.service.js";

const base = {
  applicationId: "app-1",
  documentId: "doc-9",
  expected: "bank_statements_6_months",
  detected: "tax_returns",
  confidence: 0.82,
  reason: "this looks like a tax returns rather than the bank statements 6 months it was uploaded for",
};

describe("BF_SERVER_DOC_CLASSIFY_v140 notification", () => {
  it("is addressed to staff, not the applicant", () => {
    const row = buildDocumentMismatchNotification(base);
    expect(row.userId).toBeNull();
    expect(row.metadata.audience).toBe("staff");
  });

  it("carries the evidence so staff can judge it themselves", () => {
    const row = buildDocumentMismatchNotification(base);
    expect(row.type).toBe("DOCUMENT_TYPE_MISMATCH");
    expect(row.applicationId).toBe("app-1");
    expect(row.metadata.documentId).toBe("doc-9");
    expect(row.metadata.expected).toBe("bank_statements_6_months");
    expect(row.metadata.detected).toBe("tax_returns");
    expect(row.metadata.confidence).toBe(0.82);
    expect(row.metadata.reason).toBe(base.reason);
  });

  it("states confidence as a rounded percentage", () => {
    expect(buildDocumentMismatchNotification({ ...base, confidence: 0.735 }).body).toContain("74%");
    expect(buildDocumentMismatchNotification({ ...base, confidence: 0.5 }).body).toContain("50%");
  });

  it("names both types in the body", () => {
    const row = buildDocumentMismatchNotification(base);
    expect(row.body).toContain("bank_statements_6_months");
    expect(row.body).toContain("tax_returns");
  });

  it("hedges rather than asserts - it says may be and looks like", () => {
    const row = buildDocumentMismatchNotification(base);
    expect(row.title.toLowerCase()).toContain("may be");
    expect(row.body.toLowerCase()).toContain("looks like");
  });

  it("gives every notification its own id", () => {
    const a = buildDocumentMismatchNotification(base);
    const b = buildDocumentMismatchNotification(base);
    expect(a.notificationId).not.toBe(b.notificationId);
  });
});
