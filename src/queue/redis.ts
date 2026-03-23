import type { ConnectionOptions } from "bullmq";
import { config } from "../config";

export const redisConnection: ConnectionOptions = {
  url: config.redis.url,
  maxRetriesPerRequest: null,
};
