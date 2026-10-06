// BF_SERVER_SQL_CONTENT_MOCKS_v762 - guard: a test must not chain two or more mockResolvedValueOnce database answers
// (rows / rowCount) inside one test, because they are matched to queries by call ORDER. Use answerBySql from
// src/__tests__/helpers/answerBySql.ts, which answers by the SQL text instead.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function testFiles(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules") testFiles(p, out); }
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("database mocks answer by SQL content", () => {
  it("no test chains two or more call-order database answers", () => {
    const offenders: string[] = [];
    for (const f of testFiles("src")) {
      if (f.includes("integration")) continue;
      const blocks = readFileSync(f, "utf8").split(/\n\s*(?:it|test)(?:\.each\([^)]*\))?\(/);
      blocks.slice(1).forEach((b, i) => {
        const n = (b.match(/\.mockResolvedValueOnce\(\s*\{\s*(?:rows|rowCount)/g) ?? []).length;
        if (n >= 2) offenders.push(f + " (test " + (i + 1) + ")");
      });
    }
    expect(offenders).toEqual([]);
  });
});
