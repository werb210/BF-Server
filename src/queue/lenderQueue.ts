import { Queue } from "bullmq";
import { redisConnection } from "./redis";
import { config } from "../config";

export const LENDER_QUEUE_NAME = "lender-package";

type LenderPackageJobPayload = {
  application: Record<string, unknown>;
  documents: unknown[];
  creditSummary: Record<string, unknown>;
};

let lenderQueue: Queue<LenderPackageJobPayload> | null = null;

function getLenderQueue(): Queue<LenderPackageJobPayload> {
  if (!config.redis.url) {
    throw new Error("redis_not_configured");
  }

  if (!lenderQueue) {
    lenderQueue = new Queue<LenderPackageJobPayload>(LENDER_QUEUE_NAME, {
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

export async function enqueueLenderPackage(payload: LenderPackageJobPayload): Promise<string> {
  const queue = getLenderQueue();
  const job = await queue.add("send-lender-package", payload);
  return String(job.id);
}
