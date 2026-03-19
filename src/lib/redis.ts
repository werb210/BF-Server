import Redis from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:6379";

export const redis = new Redis(url);

redis.on("connect", () => console.log("Redis connected"));
redis.on("error", (e) => console.error("Redis error", e.message));

export async function setOtp(phone: string, code: string) {
  await redis.set(`otp:${phone}`, code, "EX", 300);
}

export async function getOtp(phone: string) {
  return redis.get(`otp:${phone}`);
}

export async function deleteOtp(phone: string) {
  await redis.del(`otp:${phone}`);
}
