// BF_SERVER_LENDER_INGEST_v57 - guards the wiring, because the previous version
// compiled, ran, returned 201, and indexed nothing for months.
import { describe, it, expect } from "vitest";
import fs from "fs";

const SRC = fs.readFileSync("src/routes/lenderSelf.ts", "utf8");

describe("lender uploads train Maya", () => {
  it("calls embedAndStore, the path staff uploads use", () => {
    expect(SRC).toContain("embedAndStore(");
    expect(SRC).toContain("extractTextFromBuffer");
  });

  it("no longer posts to the non-existent Maya ingest route", () => {
    expect(SRC).not.toContain("/api/knowledge/ingest");
  });

  it("does not swallow ingest failures silently", () => {
    expect(SRC).not.toContain(".catch(() => undefined)");
    expect(SRC).toContain("[LENDER_UPLOAD][INGEST]");
  });

  it("tags lender material distinctly in the knowledge base", () => {
    expect(SRC).toContain('"lender_document"');
  });

  it("reports index status to the caller", () => {
    expect(SRC).toContain("indexed");
    expect(SRC).toContain("indexError");
  });
});
