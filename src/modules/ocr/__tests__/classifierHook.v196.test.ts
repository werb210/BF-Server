// BF_SERVER_DOCUMENT_CLASSIFIER_v196
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const svc = readFileSync("src/modules/ocr/ocr.service.ts", "utf-8");
const mig = readFileSync("migrations/2026_09_15_v196_document_classification.sql", "utf-8");

describe("ocr classification hook", () => {
  it("runs after the extraction is already banked", () => {
    const successCall = svc.indexOf("await markOcrJobSuccess");
    expect(successCall).toBeLessThan(svc.indexOf("classifyText(result.text", successCall));
  });

  it("can never fail the OCR job it rides on", () => {
    const start = svc.indexOf("BF_SERVER_DOCUMENT_CLASSIFIER_v196", svc.indexOf("await markOcrJobSuccess"));
    const hook = svc.slice(start);
    expect(hook.slice(0, hook.indexOf("document_classify_failed"))).toContain("try {");
    expect(hook).toContain("logError(\"document_classify_failed\"");
  });

  it("preserves the applicant's original category before retagging", () => {
    expect(svc).toContain("category_before_retag = COALESCE(category_before_retag, category)");
  });

  it("logs every retag with both sides of the change", () => {
    expect(svc).toMatch(/logInfo\("document_retagged"[\s\S]{0,200}from: currentCategory/);
  });
});

describe("migration", () => {
  it("is idempotent", () => {
    expect(mig.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(4);
    expect(mig).toContain("CREATE INDEX IF NOT EXISTS");
  });
});
