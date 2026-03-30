"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ocrQueue = exports.OCR_QUEUE_NAME = void 0;
const bullmq_1 = require("bullmq");
const redis_1 = require("./redis");
exports.OCR_QUEUE_NAME = "ocr-processing";
exports.ocrQueue = new bullmq_1.Queue(exports.OCR_QUEUE_NAME, {
    connection: redis_1.redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 30000
        },
        removeOnComplete: true,
        removeOnFail: false
    }
});
