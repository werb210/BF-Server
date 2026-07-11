// BF_SERVER_RECEPTION_NO_VM_HIJACK_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const s = readFileSync(path.join(process.cwd(), "src/routes/reception.ts"), "utf8");
describe("reception no voicemail hijack", () => {
  it("dials the browser client OR the cell, never both in parallel", () => {
    expect(s).toContain("if (t.clientReady && t.identity) dial.client(t.identity);\n    else if (t.cell) dial.number(t.cell);");
    expect(s).not.toContain("if (t.clientReady && t.identity) dial.client(t.identity);\n    if (t.cell) dial.number(t.cell);");
  });
});
