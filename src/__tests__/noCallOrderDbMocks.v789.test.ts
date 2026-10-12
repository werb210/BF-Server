// BF_SERVER_v789_SQL_CONTENT_MOCKS - guard: no test may answer a database query by call ORDER.
// v762 only caught two or more chained answers inside one test. This catches ANY single *Once mock
// (resolved value, return value or implementation) whose argument mentions rows / rowCount, in every
// test file under src/ and tests/ (integration tests included). Answer by SQL text instead with
// answerBySql from src/__tests__/helpers/answerBySql.ts, and assert with callsMatching.
// Non-database *Once mocks (fetch, twilio, OCR, ...) are not affected.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Files other engineers are converting right now. The lead removes each entry once its file is converted.
// Do NOT add new entries: convert the test instead.
const ALLOWLIST = new Set<string>([
]);

const SELF = "src/__tests__/noCallOrderDbMocks.v789.test.ts";

function testFiles(dir: string, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "dist") testFiles(p, out); }
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(n)) out.push(p.split("\\").join("/"));
  }
  return out;
}

/** The text between the "(" at `open` and its matching ")", skipping over string literals. */
function argumentAt(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

function callOrderDbMocks(file: string, src: string): string[] {
  const out: string[] = [];
  const call = /\.mock(?:ResolvedValue|ReturnValue|Implementation)Once\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src))) {
    const arg = argumentAt(src, m.index + m[0].length - 1);
    if (/\b(?:rows|rowCount)\b/.test(arg)) out.push(file + ":" + src.slice(0, m.index).split("\n").length);
  }
  return out;
}

describe("BF_SERVER_v789 database mocks answer by SQL content", () => {
  it("detects a single call-order database answer, and ignores non-database *Once mocks", () => {
    const bad = ["const q = vi.fn();", "q.mockResolvedValue" + "Once({ rows: [{ id: 1 }] });"].join("\n");
    expect(callOrderDbMocks("x.test.ts", bad)).toEqual(["x.test.ts:2"]);
    const impl = "q.mockImplementation" + "Once(async () => ({\n  rowCount: 1 }));";
    expect(callOrderDbMocks("y.test.ts", impl)).toEqual(["y.test.ts:1"]);
    const ok = "send.mockResolvedValue" + "Once({ sid: \"SM1\" }); q.mockImplementation(answerBySql([[/FROM users/, { rows: [] }]]));";
    expect(callOrderDbMocks("z.test.ts", ok)).toEqual([]);
  });

  it("no test answers a database query by call order (mock*Once with rows / rowCount)", () => {
    const offenders: string[] = [];
    for (const f of [...testFiles("src"), ...testFiles("tests")]) {
      if (f === SELF || ALLOWLIST.has(f)) continue;
      offenders.push(...callOrderDbMocks(f, readFileSync(f, "utf8")));
    }
    expect(
      offenders,
      "Call-order database mocks found (use answerBySql / callsMatching from src/__tests__/helpers/answerBySql.ts):\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("the allowlist only names files that still exist", () => {
    const all = new Set([...testFiles("src"), ...testFiles("tests")]);
    expect([...ALLOWLIST].filter((f) => !all.has(f))).toEqual([]);
  });
});
