import { Redis } from "ioredis";

type RedisClient = {
  get: (key: string) => Promise<string | null>;
  set: (...args: any[]) => Promise<"OK" | string>;
  del: (key: string) => Promise<number>;
  connect: () => Promise<unknown>;
  on: (event: 'error', listener: (err: unknown) => void) => unknown;
};

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
    const client = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });

    client.on('error', (err) => {
      console.error('redis_error', err);
    });
    redis = client as unknown as RedisClient;
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
