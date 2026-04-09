import fs from "node:fs";
import path from "node:path";

const distPath = path.resolve("dist");

if (!fs.existsSync(distPath)) {
  console.error("Build verification failed: dist folder missing");
  process.exit(1);
}

const serverFile = path.join(distPath, "server.js");

if (!fs.existsSync(serverFile)) {
  console.error("Build verification failed: server.js missing");
  process.exit(1);
}

console.log("Build verification passed");
process.exit(0);
