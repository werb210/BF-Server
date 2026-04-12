import { safeImport } from "../utils/safeImport.js";

type RedisClient = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, mode?: string, ttl?: number) => Promise<string>;
  del: (key: string) => Promise<number>;
  connect: () => Promise<unknown>;
  on: (event: 'error', listener: (err: unknown) => void) => unknown;
};

type RedisConstructor = new (
  url: string,
  options?: {
    lazyConnect?: boolean;
    maxRetriesPerRequest?: number;
    enableReadyCheck?: boolean;
  }
) => RedisClient;

const redisModule = await safeImport<any>("ioredis");
const RedisCtor = (redisModule?.default || redisModule) as RedisConstructor | null;

let redis: RedisClient | null = null;

const memoryStore = new Map<string, string>();
const inMemoryStore = createInMemoryRedis();

function createInMemoryRedis(): RedisClient {
  return {
    get: async (key: string) => memoryStore.get(key) ?? null,
    set: async (key: string, value: string) => {
      memoryStore.set(key, value);
      return 'OK';
    },
    del: async (key: string) => {
      const existed = memoryStore.delete(key);
      return existed ? 1 : 0;
    },
    connect: async () => undefined,
    on: () => undefined,
  };
}

function getRedisClientOrNull(): RedisClient | null {
  if (process.env.NODE_ENV === 'test') {
    return inMemoryStore;
  }

  if (!process.env.REDIS_URL) {
    console.warn('redis_url_missing');
    return null;
  }

  if (!redis) {
    if (!RedisCtor) {
      console.warn("redis_client_unavailable");
      return null;
    }
    redis = new RedisCtor(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });

    redis.on('error', (err) => {
      console.error('redis_error', err);
    });
  }

  return redis;
}

export function getRedisOrNull(): RedisClient | null {
  return getRedisClientOrNull();
}

export function getRedis(): RedisClient {
  const client = getRedisClientOrNull();
  if (!client) {
    throw new Error('REDIS_URL required outside test');
  }
  return client;
}

export async function connectRedis(): Promise<void> {
  const client = getRedisClientOrNull();
  if (!client) return;

  try {
    await client.connect();
    console.log('redis_connected');
  } catch (err) {
    console.error('redis_connect_failed', err);
  }
}

export function resetRedisMock(): void {
  memoryStore.clear();
  if (process.env.NODE_ENV === 'test') {
    redis = null;
  }
}

export async function setOtp(phone: string, code: string) {
  const client = getRedis();
  await client.set(`otp:${phone}`, code, 'EX', 300);
}

export async function fetchOtp(phone: string) {
  const client = getRedis();
  return client.get(`otp:${phone}`);
}

export async function deleteOtp(phone: string) {
  const client = getRedis();
  await client.del(`otp:${phone}`);
}
