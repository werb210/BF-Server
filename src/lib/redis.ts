type RedisLike = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, mode?: string, ttl?: number) => Promise<string>;
  del: (key: string) => Promise<number>;
};

let client: RedisLike | null = null;

const memoryStore = new Map<string, string>();
const inMemoryStore = createInMemoryRedis();

function createInMemoryRedis(): RedisLike {
  return {
    get: async (key: string) => memoryStore.get(key) ?? null,
    set: async (key: string, value: string) => {
      memoryStore.set(key, value);
      return "OK";
    },
    del: async (key: string) => {
      const existed = memoryStore.delete(key);
      return existed ? 1 : 0;
    },
  };
}

export function getRedisOrNull(): RedisLike | null {
  if (process.env.NODE_ENV === "test") {
    return inMemoryStore;
  }

  if (!process.env.REDIS_URL) {
    return null;
  }

  if (!client) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Redis = require("ioredis");
    client = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy: () => null,
    }) as RedisLike;
  }

  return client;
}

export function getRedis(): RedisLike {
  const redis = getRedisOrNull();
  if (!redis) {
    throw new Error("REDIS_URL required outside test");
  }
  return redis;
}

export function resetRedisMock(): void {
  memoryStore.clear();
  if (process.env.NODE_ENV === "test") {
    client = null;
  }
}

export async function setOtp(phone: string, code: string) {
  await getRedis().set(`otp:${phone}`, code, "EX", 300);
}

export async function fetchOtp(phone: string) {
  return getRedis().get(`otp:${phone}`);
}

export async function deleteOtp(phone: string) {
  await getRedis().del(`otp:${phone}`);
}
