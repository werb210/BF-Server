const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const functionLike = /\b(function\b|=>|\b(?:if|for|while|switch|catch)\b|\))|\{/;
const offenders = [];

for (const file of walk(path.resolve('src'))) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (!line.includes('getEnv()')) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    let foundScope = false;
    for (let i = idx; i >= Math.max(0, idx - 25); i -= 1) {
      const prior = lines[i].trim();
      if (!prior) continue;
      if (functionLike.test(prior)) {
        foundScope = true;
      }
      if (prior.endsWith('{')) break;
    }

    if (!foundScope) {
      offenders.push(`${path.relative(process.cwd(), file)}:${idx + 1}`);
    }
  });
}

if (offenders.length > 0) {
  console.error('Found getEnv() usage outside function/init scope:');
  offenders.forEach((o) => console.error(` - ${o}`));
  process.exit(1);
}

console.log('getEnv() scope guard passed');
