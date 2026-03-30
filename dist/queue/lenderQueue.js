"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LENDER_QUEUE_NAME = void 0;
exports.getLenderQueue = getLenderQueue;
exports.enqueueLenderPackage = enqueueLenderPackage;
const bullmq_1 = require("bullmq");
const redis_1 = require("./redis");
const config_1 = require("../config");
exports.LENDER_QUEUE_NAME = "lender-package";
let lenderQueue = null;
function getLenderQueue() {
    if (!config_1.config.redis.url) {
        return null;
    }
    if (!lenderQueue) {
        lenderQueue = new bullmq_1.Queue(exports.LENDER_QUEUE_NAME, {
            connection: redis_1.redisConnection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: "exponential",
                    delay: 2000,
                },
                removeOnComplete: true,
                removeOnFail: false,
            },
        });
    }
    return lenderQueue;
}
async function enqueueLenderPackage(payload) {
    const queue = getLenderQueue();
    if (!queue) {
        throw new Error("redis_not_configured");
    }
    const job = await queue.add("send-lender-package", payload);
    return String(job.id);
}
