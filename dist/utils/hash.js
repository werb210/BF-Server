"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashRequest = hashRequest;
const crypto_1 = __importDefault(require("crypto"));
function hashRequest(body) {
    return crypto_1.default.createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}
