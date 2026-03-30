"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sha256File = sha256File;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
function sha256File(path) {
    const file = fs_1.default.readFileSync(path);
    const hash = crypto_1.default.createHash("sha256");
    hash.update(file);
    return hash.digest("hex");
}
