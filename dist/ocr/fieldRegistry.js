"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchOcrFieldDefinitions = fetchOcrFieldDefinitions;
exports.fetchOcrFieldsForDocumentType = fetchOcrFieldsForDocumentType;
const ocrFieldRegistry_1 = require("./ocrFieldRegistry");
function fetchOcrFieldDefinitions() {
    return (0, ocrFieldRegistry_1.fetchOcrFieldRegistry)();
}
function fetchOcrFieldsForDocumentType() {
    return (0, ocrFieldRegistry_1.fetchOcrFieldRegistry)();
}
