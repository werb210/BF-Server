"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sha256File = sha256File;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
async function sha256File(path) {
    return new Promise((resolve, reject) => {
        const hash = crypto_1.default.createHash("sha256");
        const stream = fs_1.default.createReadStream(path);
        stream.on("data", (data) => hash.update(data));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}
