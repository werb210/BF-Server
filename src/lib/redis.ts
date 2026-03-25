import Redis from "ioredis";

const isTest = process.env.NODE_ENV === "test";
const store = new Map<string, string>();

let redis: any;

if (isTest) {
  redis = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async del(key: string) {
      store.delete(key);
    },
  };
} else {
  redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
}

export { redis };

export function resetRedisMock(): void {
  if (isTest) {
    store.clear();
  }
}

export async function setOtp(phone: string, code: string) {
  await redis.set(`otp:${phone}`, code, "EX", 300);
}

export async function fetchOtp(phone: string) {
  return redis.get(`otp:${phone}`);
}

export async function deleteOtp(phone: string) {
  await redis.del(`otp:${phone}`);
}
