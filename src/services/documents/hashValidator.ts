import crypto from "node:crypto";
import fs from "fs";

export function sha256File(path: string) {
  const file = fs.readFileSync(path);

  const hash = crypto.createHash("sha256");

  hash.update(file);

  return hash.digest("hex");
}
