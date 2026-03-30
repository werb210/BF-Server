"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueOCRJob = queueOCRJob;
const ocrQueue_1 = require("../../queue/ocrQueue");
async function queueOCRJob(data) {
    return ocrQueue_1.ocrQueue.add("ocr", data);
}
