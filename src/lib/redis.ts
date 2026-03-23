import Redis from "ioredis";

let redisClient: Redis | null = null;
const isTestMode = process.env.TEST_MODE === "true";

export function initRedis(): Redis | null {
  if (isTestMode) {
    console.log("TEST_MODE enabled — skipping Redis connection");
    return null;
  }

  const redisUrl = process.env.REDIS_URL?.trim();

  if (!redisUrl) {
    console.log("Redis disabled: REDIS_URL not provided");
    return null;
  }

  if (redisClient) {
    return redisClient;
  }

  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  redisClient.on("ready", () => console.log("REDIS CONNECTED"));
  redisClient.on("error", (error) => {
    console.error("REDIS ERROR", error.message);
  });

  return redisClient;
}

export const redis = isTestMode ? null : initRedis();

function requireRedis(): Redis {
  if (!redis) {
    throw new Error("Redis is disabled because REDIS_URL is missing");
  }
  return redis;
}

export async function setOtp(phone: string, code: string) {
  await requireRedis().set(`otp:${phone}`, code, "EX", 300);
}

export async function fetchOtp(phone: string) {
  return requireRedis().get(`otp:${phone}`);
}

export async function deleteOtp(phone: string) {
  await requireRedis().del(`otp:${phone}`);
}
