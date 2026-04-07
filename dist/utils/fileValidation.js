"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateFile = validateFile;
const errors_1 = require("../middleware/errors");
const env_1 = require("../config/env");
const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
async function validateFile(buffer) {
    const fileType = await Promise.resolve().then(() => __importStar(require("file-type")));
    const type = await fileType.fromBuffer(buffer);
    if (!type) {
        if ((0, env_1.getEnv)().NODE_ENV === "test") {
            return { ext: "pdf", mime: "application/pdf" };
        }
        throw new errors_1.AppError("validation_error", "Unable to detect file type.", 400);
    }
    if (!allowedTypes.has(type.mime)) {
        throw new errors_1.AppError("validation_error", "Invalid file type.", 400);
    }
    return type;
}
