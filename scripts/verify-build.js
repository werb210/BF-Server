const fs = require("fs");

const requiredFiles = [
  "dist/index.js",
  "dist/routes/index.js",
  "dist/routes/auth/index.js",
  "dist/config/env.js",
];

const missing = requiredFiles.filter((file) => !fs.existsSync(file));

if (missing.length > 0) {
  console.error("ERROR: dist build is incomplete. Missing files:");
  for (const file of missing) {
    console.error(` - ${file}`);
  }
  process.exit(1);
}

console.log("Build verified");
