// BF_SERVER_NO_FORBIDDEN_NUMBER_v1
// One phone number must never appear anywhere in this repo. The guard stores
// only the sha256 of its ten digits, so the guard itself never contains it.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const FORBIDDEN_SHA256 = "d1b175b297c9bbf43b5572be8519a07f38c97f5512af01264798a19281c3b305";
const ROOT = path.resolve(__dirname, "../..");
const SCAN = ["src", "scripts", "migrations", "docs", "test", "tests", "contracts", "shared-contract", ".github"];
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|sql|md|txt|yml|yaml|py|sh|html|csv)$/i;

function* files(dir: string): Generator<string> {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* files(full);
    else if (TEXT.test(name) && st.size < 5_000_000) yield full;
  }
}

function tenDigitRuns(text: string): string[] {
  // Collapse common separators so (xxx) xxx-xxxx, xxx.xxx.xxxx and +1xxxxxxxxxx all reduce to digits.
  const out: string[] = [];
  const re = /\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/g;
  for (const m of text.match(re) ?? []) {
    const d = m.replace(/\D/g, "");
    out.push(d.slice(-10));
  }
  return out;
}

describe("forbidden number guard", () => {
  it("the forbidden number does not appear in any tracked source file", () => {
    const hits: string[] = [];
    for (const dir of SCAN) {
      for (const file of files(path.join(ROOT, dir))) {
        const text = readFileSync(file, "utf8");
        for (const d of tenDigitRuns(text)) {
          if (createHash("sha256").update(d).digest("hex") === FORBIDDEN_SHA256) {
            hits.push(path.relative(ROOT, file));
            break;
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
