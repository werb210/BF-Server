// BF_SERVER_BLOCK_1_30B_BANKING_WORKER_TRIGGER
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("BF_SERVER_BLOCK_1_30B_BANKING_WORKER_TRIGGER — worker contract", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../bankingAutoWorker.ts"),
    "utf8",
  );

  it("calls runBankingAnalysis from the new pipeline", () => {
    expect(src).toContain("runBankingAnalysis(applicationId");
    expect(src).toContain("from \"../services/banking/bankingAnalysisPipeline.js\"");
  });

  it("resolves fetchBuffer via the OCR storage resolver (BF_SERVER_BLOCK_v688_BANKING_STORAGE_REF_v1)", () => {
    expect(src).toContain("createOcrStorage().fetchBuffer");
    expect(src).toContain("from \"../modules/ocr/ocr.storage.js\"");
  });

  it("gates on banking_analyses status to avoid re-runs", () => {
    expect(src).toContain("'in_progress'");
    expect(src).toContain("'analysis_complete'");
  });

  it("no longer calls the legacy analyzeBankStatements stub", () => {
    expect(src).not.toContain("analyzeBankStatements");
    expect(src).not.toContain("buildBankingFromOcr");
  });

  it("parks failed analyses so they don't loop", () => {
    expect(src).toContain("'failed'");
  });
});
