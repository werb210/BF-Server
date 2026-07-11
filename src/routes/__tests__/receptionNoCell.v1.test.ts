// BF_SERVER_RECEPTION_NO_CELL_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const s = readFileSync(path.join(process.cwd(), "src/routes/reception.ts"), "utf8");
describe("reception rings browser only", () => {
  it("dials the client, never the cell number", () => {
    expect(s).toContain("BF_SERVER_RECEPTION_NO_CELL_v1");
    expect(s).toContain("dial.client(t.identity);");
    expect(s).not.toContain("dial.number(t.cell)");
  });
});
