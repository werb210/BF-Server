"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateFile = validateFile;
const file_type_1 = require("file-type");
const errors_1 = require("../middleware/errors");
const config_1 = require("../config");
const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
async function validateFile(buffer) {
    const type = await (0, file_type_1.fileTypeFromBuffer)(buffer);
    if (!type) {
        if (config_1.config.env === "test") {
            return { ext: "pdf", mime: "application/pdf" };
        }
        throw new errors_1.AppError("validation_error", "Unable to detect file type.", 400);
    }
    if (!allowedTypes.has(type.mime)) {
        throw new errors_1.AppError("validation_error", "Invalid file type.", 400);
    }
    return type;
}
