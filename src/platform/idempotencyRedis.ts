import { getRedis } from "./redis";

const TTL_SECONDS = 60 * 60;

export type RedisIdempotencyRecord = {
  requestHash: string;
  response: unknown;
};

export async function getIdempotent(key: string): Promise<RedisIdempotencyRecord | null> {
  const redis = getRedis();
  if (!redis) {
    return null;
  }

  const data = await redis.get(key);
  return data ? (JSON.parse(data) as RedisIdempotencyRecord) : null;
}

export async function setIdempotent(key: string, value: RedisIdempotencyRecord): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    return;
  }

  await redis.set(key, JSON.stringify(value), "EX", TTL_SECONDS);
}
