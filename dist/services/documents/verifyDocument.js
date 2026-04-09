import fs from "fs";
import { sha256File } from "./hashFile.js";
export async function verifyDocument(path, expectedHash) {
    if (!fs.existsSync(path)) {
        throw new Error(`Document file missing: ${path}`);
    }
    if (expectedHash) {
        const actualHash = await sha256File(path);
        if (actualHash !== expectedHash) {
            throw new Error("Document hash mismatch");
        }
    }
    return true;
}
