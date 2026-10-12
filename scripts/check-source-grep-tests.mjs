#!/usr/bin/env node
// BF_SERVER_v789_SOURCE_GREP_RATCHET
// Counts test files that read a file under src/ (readFileSync / fs.readFile /
// readFile) to assert on its source text. Such tests pass while the behaviour
// they claim to cover is broken, and fail on harmless refactors. The count may
// only go down: CI fails when it rises above scripts/source-grep-baseline.json.
//
//   node scripts/check-source-grep-tests.mjs                 check
//   node scripts/check-source-grep-tests.mjs --list          print the files
//   node scripts/check-source-grep-tests.mjs --write-baseline
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASELINE = path.join(ROOT, "scripts", "source-grep-baseline.json");
const TEST_DIRS = ["src", "tests", "test"];
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/;
const READS_FILE = /\b(readFileSync|readFile)\s*\(/;
// A path to a source file under src/: a literal "src/....ts", a path.join /
// resolve whose segments include "src", or a __dirname-relative .ts/.js file.
const SRC_LITERAL = /["'`](?:\.\/)?src\/[^"'`\n]*\.(?:ts|tsx|js|mjs)["'`]/;
const SRC_SEGMENTS = /(?:join|resolve)\s*\((?:[^()\n]|\([^()\n]*\))*["'`]src["'`]/;
// Walking the whole tree: walk("src"), readdirSync("src"), testFiles("src").
const SRC_WALK = /\(\s*["'`](?:\.\/)?src\/?["'`]\s*[,)]/;
const DIRNAME_SOURCE = /(?:join|resolve)\s*\(\s*(?:__dirname|dirname\([^)]*\)|here|HERE|dir)\b[^)\n]*["'`][^"'`\n]*\.(?:ts|tsx|js|mjs)["'`]/;
// Helper-wrapped reads: read("../routes/x.ts"), R("routes", "x.ts"). Imports in
// this repo use .js specifiers, so a quoted *.ts path outside an import line is a
// file the test opens.
const TS_PATH_LITERAL = /["'`][\w./-]*[\w-]\.tsx?["'`]/;
const URL_SOURCE = /new\s+URL\(\s*["'`][^"'`\n]*\.(?:ts|tsx|js|mjs)["'`]\s*,\s*import\.meta\.url\s*\)/;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (TEST_FILE.test(entry.name)) out.push(p);
  }
  return out;
}

function tsLiteralOutsideImports(text) {
  return text
    .split("\n")
    .some((line) => !/^\s*(import|export)\b|\bfrom\s+["'`]|\bimport\s*\(|vi\.(mock|doMock|importActual)\s*\(/.test(line) && TS_PATH_LITERAL.test(line));
}

export function isSourceGrepTest(text) {
  if (!READS_FILE.test(text)) return false;
  return tsLiteralOutsideImports(text) || SRC_LITERAL.test(text) || SRC_SEGMENTS.test(text) || SRC_WALK.test(text) || DIRNAME_SOURCE.test(text) || URL_SOURCE.test(text);
}

export function findSourceGrepTests() {
  const files = [];
  for (const d of TEST_DIRS) walk(path.join(ROOT, d), files);
  return files
    .filter((f) => isSourceGrepTest(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
    .sort();
}

function main() {
  const found = findSourceGrepTests();
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const f of found) console.log(f);
  }
  if (args.includes("--write-baseline")) {
    fs.writeFileSync(
      BASELINE,
      JSON.stringify(
        {
          _comment:
            "BF_SERVER_v789_SOURCE_GREP_RATCHET - max number of test files that read src/ files to assert on source text. Lower it when you convert one; never raise it.",
          max: found.length,
        },
        null,
        1,
      ) + "\n",
    );
    console.log(`source-grep baseline written: ${found.length}`);
    return 0;
  }
  const max = fs.existsSync(BASELINE) ? Number(JSON.parse(fs.readFileSync(BASELINE, "utf8")).max) : 0;
  if (found.length > max) {
    console.error(
      `Source-grep tests: ${found.length} files read src/ source text to assert on it (baseline ${max}).\n` +
        "New tests must exercise behaviour (call the function, hit the route) rather than grep the source.\n" +
        "Run with --list to see them.",
    );
    return 1;
  }
  console.log(
    `source-grep tests: ${found.length} (baseline ${max})` +
      (found.length < max ? " - lower the baseline with --write-baseline" : ""),
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
