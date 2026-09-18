// BF_SERVER_STAFF_LENDER_INGEST_v347 - the staff lender-document upload must
// train Maya the same way the lender self-upload does (v57).
import { describe, it, expect } from "vitest";
import fs from "fs";

const SRC = fs.readFileSync("src/routes/portalLenders.ts", "utf8");

describe("staff lender uploads train Maya", () => {
  it("indexes through embedAndStore with extracted text", () => {
    expect(SRC).toContain("embedAndStore(pool, extractedText, \"lender_document\"");
    expect(SRC).toContain("extractTextFromBuffer");
  });
  it("no longer posts to the non-existent agent ingest route", () => {
    expect(SRC).not.toContain("/api/knowledge/ingest");
    expect(SRC).not.toContain("process.env.MAYA_URL;");
  });
  it("surfaces ingest failures instead of swallowing them", () => {
    expect(SRC).toContain("[STAFF_LENDER_UPLOAD][INGEST]");
    expect(SRC).toContain("indexError");
  });
  it("never uses the raw upload name as a disk path", () => {
    expect(SRC).not.toContain("cb(null, `${Date.now()}-${file.originalname}`)");
    expect(SRC).toContain("file.originalname.replace(/[^a-zA-Z0-9._-]/g, \"_\")");
  });
});
