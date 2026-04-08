#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function walk(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, results);
      continue;
    }

    if (exts.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

const targetDirs = ['src', 'test']
  .map((dir) => path.join(root, dir))
  .filter((dir) => fs.existsSync(dir));

const files = targetDirs.flatMap((dir) => walk(dir));
const pattern = /\b(?:it|test|describe)\s*\.\s*(?:only|skip)\s*\(/;
const violations = [];
for (const file of files) {
  const rel = path.relative(root, file);
  const src = fs.readFileSync(file, 'utf8');
  if (pattern.test(src)) {
    violations.push(rel);
  }
}

if (violations.length > 0) {
  console.error('Found forbidden .only/.skip usage in files:');
  for (const file of violations) {
    console.error(` - ${file}`);
  }
  process.exit(1);
}

console.log('No test .only/.skip detected.');
