// BF_SERVER_MIME_DOT_SUFFIX_v1 - the officedocument allowlist prefix must
// match dot-continued mimes (docx = ...officedocument.wordprocessingml.document).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const src = readFileSync(join(process.cwd(), "src", "routes", "documents.ts"), "utf-8");
describe("public upload mime allowlist", () => {
  it("accepts dot-suffixed office mimes", () => {
    expect(src).toContain('mime.startsWith(p + ".")');
    expect(src).toContain('"application/vnd.openxmlformats-officedocument"');
  });
});
