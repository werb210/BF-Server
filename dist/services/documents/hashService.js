"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashBuffer = hashBuffer;
const crypto_1 = __importDefault(require("crypto"));
function hashBuffer(buffer) {
    return crypto_1.default.createHash("sha256").update(buffer).digest("hex");
}
