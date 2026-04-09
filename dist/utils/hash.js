import crypto from "node:crypto";
export function hashRequest(body) {
    return crypto.createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}
