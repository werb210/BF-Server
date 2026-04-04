const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

if (!fs.existsSync('dist')) {
  console.error('dist is missing. Run npm run build before start.');
  process.exit(1);
}

const srcFiles = walk('src');
const distFiles = walk('dist');

if (distFiles.length === 0) {
  console.error('dist is empty. Run npm run build before start.');
  process.exit(1);
}

const latestSrcMtime = Math.max(...srcFiles.map((file) => fs.statSync(file).mtimeMs));
const latestDistMtime = Math.max(...distFiles.map((file) => fs.statSync(file).mtimeMs));

if (latestDistMtime < latestSrcMtime) {
  console.error('dist is stale. Run npm run build before start.');
  process.exit(1);
}
