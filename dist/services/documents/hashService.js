import crypto from "node:crypto";
export function hashBuffer(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}
