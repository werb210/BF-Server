// BF_SERVER_SIGNNOW_FIELD_DUMP_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
describe("signnow field dump diagnostic", () => {
  it("client exposes a raw GET helper", () => {
    expect(r("src/signnow/signnowClient.ts")).toContain("export async function signnowGetRaw");
  });
  it("diagnostics probe dumps legacy + v2 field structures", () => {
    const s = r("src/routes/admin.ts");
    expect(s).toContain("out.fieldDump");
    expect(s).toContain("/v2/documents/${documentId}");
    expect(s).toContain("v2First");
  });
});
