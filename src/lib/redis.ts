import type Redis from "ioredis";
import { redisClient } from "../platform/redisClient";

export function initRedis(): Redis {
  return redisClient;
}

export const redis = initRedis();

function requireRedis(): Redis {
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
