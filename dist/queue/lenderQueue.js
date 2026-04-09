import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";
import { config } from "../config/index.js";
export const LENDER_QUEUE_NAME = "lender-package";
let lenderQueue = null;
export function getLenderQueue() {
    if (!config.redis.url) {
        return null;
    }
    if (!lenderQueue) {
        lenderQueue = new Queue(LENDER_QUEUE_NAME, {
            connection: redisConnection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: "exponential",
                    delay: 2_000,
                },
                removeOnComplete: true,
                removeOnFail: false,
            },
        });
    }
    return lenderQueue;
}
export async function enqueueLenderPackage(payload) {
    const queue = getLenderQueue();
    if (!queue) {
        throw new Error("redis_not_configured");
    }
    const job = await queue.add("send-lender-package", payload);
    return String(job.id);
}
