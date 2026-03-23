import Redis from "ioredis";
import { logWarn } from "../observability/logger";
import { config } from "../config";

const ONE_HOUR_IN_SECONDS = 60 * 60;
const ONE_HOUR_IN_MILLISECONDS = ONE_HOUR_IN_SECONDS * 1000;
const REDIS_KEY_PREFIX = "idempotency:";

type StoredResponse = {
  statusCode: number;
  body: unknown;
  requestHash: string;
  storedAt: number;
};

const memoryStore = new Map<string, StoredResponse>();
let redisClient: Redis | null = null;
let redisReady = false;
let redisAttempted = false;

function fetchRedisClient(): Redis | null {
  if (redisAttempted) {
    return redisReady ? redisClient : null;
  }

  redisAttempted = true;
  const redisUrl = config.redis.url;
  if (!redisUrl) {
    return null;
  }

  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  void client
    .connect()
    .then(() => {
      redisClient = client;
      redisReady = true;
    })
    .catch((error: unknown) => {
      redisReady = false;
      void client.disconnect();
      logWarn("idempotency_redis_unavailable", {
        error: error instanceof Error ? error.message : "redis_connect_failed",
      });
    });

  return null;
}

function memoryFallbackGet(key: string): StoredResponse | undefined {
  return memoryStore.get(key);
}

function memoryFallbackSet(key: string, value: StoredResponse): void {
  memoryStore.set(key, value);
  setTimeout(() => {
    memoryStore.delete(key);
  }, ONE_HOUR_IN_MILLISECONDS);
}

export async function fetchStoredResponse(key: string): Promise<StoredResponse | undefined> {
  const client = fetchRedisClient();
  if (client) {
    try {
      const payload = await client.get(`${REDIS_KEY_PREFIX}${key}`);
      if (!payload) {
        return undefined;
      }
      return JSON.parse(payload) as StoredResponse;
    } catch {
      return memoryFallbackGet(key);
    }
  }

  return memoryFallbackGet(key);
}

export async function storeResponse(key: string, value: StoredResponse): Promise<void> {
  const client = fetchRedisClient();
  if (client) {
    try {
      await client.set(
        `${REDIS_KEY_PREFIX}${key}`,
        JSON.stringify(value),
        "EX",
        ONE_HOUR_IN_SECONDS
      );
      return;
    } catch {
      memoryFallbackSet(key, value);
      return;
    }
  }

  memoryFallbackSet(key, value);
}

export function resetIdempotencyStoreForTests(): void {
  if (config.env === "test") {
    memoryStore.clear();
  }
}
