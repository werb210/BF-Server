#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const entrypoint = path.resolve(repoRoot, "src/routes/index.ts");
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];

function resolveSourceImport(importer, specifier) {
  if (!specifier.startsWith(".")) return null;

  const unresolved = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(unresolved);
  const bases = extension === ".js" || extension === ".mjs" || extension === ".cjs"
    ? [unresolved.slice(0, -extension.length)]
    : [unresolved];

  for (const base of bases) {
    for (const candidate of [
      ...sourceExtensions.map((sourceExtension) => `${base}${sourceExtension}`),
      ...sourceExtensions.map((sourceExtension) => path.join(base, `index${sourceExtension}`)),
    ]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

function inspectSource(filename) {
  const sourceText = fs.readFileSync(filename, "utf8");
  const imports = [];
  const topLevelAwaits = [];

  const importPattern = /^(?:import(?:[\s\S]*?\sfrom\s*|\s*)|export[\s\S]*?\sfrom\s*)["']([^"']+)["']/gm;
  for (const match of sourceText.matchAll(importPattern)) imports.push(match[1]);

  // Route-breaking awaits have historically initialized a top-level variable.
  // Keep the optional type annotation in this pattern: `const x: any = await`
  // is the real production shape this guard was introduced to catch.
  const tlaPattern = /^(?:(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:[^=\n]+)?\s*=\s*await\b|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*=\s*await\b|await\b|for\s+await\b)/gm;
  for (const match of sourceText.matchAll(tlaPattern)) {
    const before = sourceText.slice(0, match.index);
    const line = before.split("\n").length;
    const lineStart = before.lastIndexOf("\n") + 1;
    const column = match.index - lineStart + match[0].search(/\S/) + 1;
    topLevelAwaits.push({ line, column });
  }

  return { imports, topLevelAwaits };
}

if (!fs.existsSync(entrypoint)) {
  console.error("Route entrypoint not found: src/routes/index.ts");
  process.exit(2);
}

const visited = new Set();
const stack = [{ filename: entrypoint, chain: [entrypoint] }];
const violations = [];

while (stack.length > 0) {
  const { filename, chain } = stack.pop();
  if (visited.has(filename)) continue;
  visited.add(filename);

  const { imports, topLevelAwaits } = inspectSource(filename);
  for (const location of topLevelAwaits) violations.push({ chain, ...location });

  for (const specifier of imports) {
    const dependency = resolveSourceImport(filename, specifier);
    if (dependency && !visited.has(dependency)) {
      stack.push({ filename: dependency, chain: [...chain, dependency] });
    }
  }
}

const relative = (filename) => path.relative(repoRoot, filename).split(path.sep).join("/");
if (violations.length > 0) {
  console.error("ERROR: top-level await is reachable from src/routes/index.ts.");
  console.error("This graph must remain compatible with require() during deploy verification.\n");
  for (const violation of violations) {
    console.error(`Top-level await at ${relative(violation.chain.at(-1))}:${violation.line}:${violation.column}`);
    console.error(`Import chain: ${violation.chain.map(relative).join(" -> ")}\n`);
  }
  process.exit(1);
}

console.log(`Route import graph is free of top-level await (${visited.size} modules checked).`);
