import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("Missing REDIS_URL");
}

const redis = new Redis(redisUrl);

export { redis };

export function resetRedisMock(): void {
  // no-op: runtime uses Redis only
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
