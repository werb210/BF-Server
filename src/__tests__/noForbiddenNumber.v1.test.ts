// BF_SERVER_NO_FORBIDDEN_NUMBER_v1 - a real phone number must never appear in a
// tracked file. Only its sha256 (of the 10-digit national number) lives here.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const FORBIDDEN_SHA256 = "d1b175b297c9bbf43b5572be8519a07f38c97f5512af01264798a19281c3b305";
const MAX_BYTES = 5 * 1024 * 1024;

function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter((f) => f && !f.split("/").includes("node_modules"));
}

describe("no tracked file contains the forbidden phone number", () => {
  it("scans every 10-digit window of every digit run", () => {
    const root = process.cwd();
    const offenders: string[] = [];
    for (const rel of trackedFiles(root)) {
      const abs = path.join(root, rel);
      let buf: Buffer;
      try {
        if (!statSync(abs).isFile() || statSync(abs).size > MAX_BYTES) continue;
        buf = readFileSync(abs);
      } catch {
        continue; // deleted in the working tree
      }
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      const text = buf.toString("utf8");
      for (const m of text.matchAll(/\d{10,}/g)) {
        const run = m[0];
        let hit = false;
        for (let i = 0; i + 10 <= run.length; i++) {
          if (createHash("sha256").update(run.slice(i, i + 10)).digest("hex") === FORBIDDEN_SHA256) { hit = true; break; }
        }
        if (hit) { offenders.push(rel); break; }
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});
