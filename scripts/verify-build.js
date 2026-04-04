const fs = require("fs");
const path = require("path");

const REQUIRED_DIST_FILES = [
  "dist/index.js",
  "dist/routes/index.js",
  "dist/routes/auth/index.js",
  "dist/config/env.js",
];

function walkFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function verifyDistFilesExist() {
  const missing = REQUIRED_DIST_FILES.filter((file) => !fs.existsSync(file));
  if (missing.length === 0) {
    return;
  }
  console.error("ERROR: dist build is incomplete. Missing files:");
  missing.forEach((file) => console.error(` - ${file}`));
  process.exit(1);
}

function verifyDistIsNewerThanSource() {
  if (!fs.existsSync("src")) {
    console.error("ERROR: src directory is missing.");
    process.exit(1);
  }
  if (!fs.existsSync("dist")) {
    console.error("ERROR: dist directory is missing.");
    process.exit(1);
  }

  const srcFiles = walkFiles("src");
  const distFiles = walkFiles("dist");

  if (srcFiles.length === 0) {
    console.error("ERROR: src directory has no files.");
    process.exit(1);
  }
  if (distFiles.length === 0) {
    console.error("ERROR: dist directory has no files.");
    process.exit(1);
  }

  const newestSrcMtime = Math.max(...srcFiles.map((file) => fs.statSync(file).mtimeMs));
  const oldestDistMtime = Math.min(...distFiles.map((file) => fs.statSync(file).mtimeMs));

  if (oldestDistMtime < newestSrcMtime) {
    console.error("ERROR: dist artifacts are older than src files. Rebuild required.");
    process.exit(1);
  }
}

verifyDistFilesExist();
verifyDistIsNewerThanSource();
console.log("Build verified");
