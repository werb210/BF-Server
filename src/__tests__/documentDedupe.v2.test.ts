import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(join(process.cwd(), path), "utf-8");
const pnw = readSource("src/signnow/pnwSigning.ts");
const termSheet = readSource("src/services/signnow/sendOfferTermSheet.ts");

describe("signed document identity dedupe", () => {
  it("dedupes system-generated PNWs by application and document type before download", () => {
    const identityCheck = pnw.indexOf("AND document_type = 'personal_net_worth'");
    expect(identityCheck).toBeGreaterThan(-1);
    expect(pnw).toContain("AND uploaded_by = 'system'");
    expect(identityCheck).toBeLessThan(pnw.indexOf("getDocumentGroupStatus(groupId)", identityCheck));
    expect(identityCheck).toBeLessThan(pnw.indexOf("downloadDocument(docId)", identityCheck));
    expect(pnw).not.toContain("AND hash = $2");
  });

  it("dedupes system-generated signed term sheets by application and document type before download", () => {
    const identityCheck = termSheet.indexOf("AND document_type = 'signed_term_sheet'");
    expect(identityCheck).toBeGreaterThan(-1);
    expect(termSheet).toContain("AND uploaded_by = 'system'");
    expect(identityCheck).toBeLessThan(termSheet.indexOf("getDocumentGroupStatus(groupId)", identityCheck));
    expect(identityCheck).toBeLessThan(termSheet.indexOf("downloadDocument(docId)", identityCheck));
    expect(termSheet).not.toContain("AND hash = $2");
  });

  it("continues writing hashes for integrity metadata", () => {
    expect(pnw).toContain('createHash("sha256").update(pdf)');
    expect(termSheet).toContain('createHash("sha256").update(pdf)');
  });
});
