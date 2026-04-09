import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
const serverFile = path.join(dist, "server.js");

if (!fs.existsSync(dist)) {
  console.error("dist folder missing");
  process.exit(1);
}

if (!fs.existsSync(serverFile)) {
  console.error("dist/server.js missing");
  process.exit(1);
}

console.log("Build verification passed");
process.exit(0);
