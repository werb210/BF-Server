import fs from "fs";
import crypto from "crypto";

export function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);

  return new Promise<string>((resolve, reject) => {
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function verifyDocument(filePath: string, expected?: string): Promise<true> {
  if (!fs.existsSync(filePath)) {
    throw new Error("Document missing");
  }

  if (!expected) return true;

  const hash = await sha256File(filePath);

  if (hash !== expected) {
    throw new Error("Document hash mismatch");
  }

  return true;
}
