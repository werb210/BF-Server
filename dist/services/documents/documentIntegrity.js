"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sha256File = sha256File;
exports.verifyDocument = verifyDocument;
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
function sha256File(filePath) {
    const hash = crypto_1.default.createHash("sha256");
    const stream = fs_1.default.createReadStream(filePath);
    return new Promise((resolve, reject) => {
        stream.on("data", (d) => hash.update(d));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}
async function verifyDocument(filePath, expected) {
    if (!fs_1.default.existsSync(filePath)) {
        throw new Error("Document missing");
    }
    if (!expected)
        return true;
    const hash = await sha256File(filePath);
    if (hash !== expected) {
        throw new Error("Document hash mismatch");
    }
    return true;
}
