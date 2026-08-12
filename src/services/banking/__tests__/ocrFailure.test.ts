// BF_SERVER_OCR_QUOTA_v47
import { describe, it, expect } from "vitest";
import { classifyOcrFailure, isInfrastructureFailure, anyInfrastructureFailure, describeOcrFailure } from "../ocrFailure.js";

const QUOTA_403 = "OCR model prebuilt-bankStatement.us failed: Doc Intel 403: Out of call volume quota for FormRecognizer F0 pricing tier. Please retry after 28 days. To increase your call volume switch to a paid tier.";

describe("classifyOcrFailure", () => {
  it("recognises the F0 quota 403 seen in production", () => {
    expect(classifyOcrFailure(QUOTA_403)).toBe("quota");
  });

  it("separates auth, throttling, outage and config from a bad upload", () => {
    expect(classifyOcrFailure("Doc Intel 401: invalid subscription key")).toBe("auth");
    expect(classifyOcrFailure("Doc Intel 429: Too Many Requests")).toBe("throttled");
    expect(classifyOcrFailure("getaddrinfo EAI_AGAIN cognitiveservices")).toBe("unavailable");
    expect(classifyOcrFailure("AZURE_DOC_INTEL_KEY not set")).toBe("config");
    expect(classifyOcrFailure("no tables detected in document")).toBe("other");
    expect(classifyOcrFailure(null)).toBe("other");
  });
});

describe("isInfrastructureFailure", () => {
  it("counts vendor problems as ours, not the applicant's", () => {
    expect(isInfrastructureFailure("quota")).toBe(true);
    expect(isInfrastructureFailure("auth")).toBe(true);
    expect(isInfrastructureFailure("throttled")).toBe(true);
    expect(isInfrastructureFailure("unavailable")).toBe(true);
    expect(isInfrastructureFailure("config")).toBe(true);
  });

  it("leaves a genuinely unreadable upload as the applicant's problem", () => {
    expect(isInfrastructureFailure("other")).toBe(false);
  });

  it("flags a batch where any document hit infrastructure", () => {
    expect(anyInfrastructureFailure(["no tables detected", QUOTA_403])).toBe(true);
    expect(anyInfrastructureFailure([describeOcrFailure("auth", "401")])).toBe(true);
    expect(anyInfrastructureFailure([describeOcrFailure("unavailable", "timeout")])).toBe(true);
    expect(anyInfrastructureFailure(["no tables detected", null])).toBe(false);
  });
});

describe("describeOcrFailure", () => {
  it("says plainly that quota is an account limit, not a bad upload", () => {
    const msg = describeOcrFailure("quota", QUOTA_403);
    expect(msg).toContain("not a problem with the uploaded documents");
    expect(msg).toContain("paid tier");
  });

  it("passes an unrecognised failure through unchanged", () => {
    expect(describeOcrFailure("other", "weird parser error")).toBe("weird parser error");
  });
});
