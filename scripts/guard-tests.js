#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'coverage']);

function walk(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) {
        continue;
      }
      walk(fullPath, results);
      continue;
    }

    if (exts.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

const targetDirs = ['src', 'tests', 'scripts']
  .map((dir) => path.join(root, dir))
  .filter((dir) => fs.existsSync(dir));

const files = targetDirs.flatMap((dir) => walk(dir));
const pattern = /\.(only|skip)\s*\(/;
for (const file of files) {
  const rel = path.relative(root, file);
  const src = fs.readFileSync(file, 'utf8');
  const match = src.match(pattern);
  if (match) {
    console.error('Found forbidden .only/.skip usage.');
    console.error(` - ${rel}: ${match[0]}`);
    process.exit(1);
  }
}

console.log('No test .only/.skip detected.');
