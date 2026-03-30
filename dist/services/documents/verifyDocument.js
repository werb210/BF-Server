"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyDocument = verifyDocument;
const fs_1 = __importDefault(require("fs"));
const hashFile_1 = require("./hashFile");
async function verifyDocument(path, expectedHash) {
    if (!fs_1.default.existsSync(path)) {
        throw new Error(`Document file missing: ${path}`);
    }
    if (expectedHash) {
        const actualHash = await (0, hashFile_1.sha256File)(path);
        if (actualHash !== expectedHash) {
            throw new Error("Document hash mismatch");
        }
    }
    return true;
}
