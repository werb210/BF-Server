import type { ConnectionOptions } from "bullmq"

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379"

export const redisConnection: ConnectionOptions = {
  url: redisUrl,
  maxRetriesPerRequest: null,
}
