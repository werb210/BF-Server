import crypto from "crypto";
import { Router } from "express";
import { config } from "../config";

import { pool } from "../lib/dbClient";
import { getRedisOrNull } from "../lib/redis";
import { fetchOtp, storeOtp } from "../services/otpService";

type TestStatus = "ok" | "fail";
type RedisStatus = TestStatus | "missing";

type DiagnosticResponse = {
  status: "ok" | "fail";
  tests: {
    db: { status: TestStatus; error?: string };
    users: { status: TestStatus; error?: string };
    lenders: { status: TestStatus; count?: number; error?: string };
    products: { status: TestStatus; count?: number; error?: string };
    otp: { status: TestStatus; stored: string | null; expected: string; error?: string };
    redis: { status: RedisStatus; error?: string };
    env: {
      db: boolean;
      dbSsl: boolean;
      redis: boolean;
      jwt: boolean;
    };
  };
};

const systemCheckRouter = Router();

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "unknown_error";
}

systemCheckRouter.get("/system-check", async (_req: any, res: any) => {
  const tests: DiagnosticResponse["tests"] = {
    db: { status: "fail" },
    users: { status: "fail" },
    lenders: { status: "fail" },
    products: { status: "fail" },
    otp: { status: "fail", stored: null, expected: "654321" },
    redis: { status: "missing" },
    env: {
      db: Boolean(config.db.host?.trim()),
      dbSsl: String(config.db.ssl ?? "").trim().toLowerCase() === "true",
      redis: Boolean(config.redis.url?.trim()),
      jwt: Boolean(config.jwt.secret?.trim()),
    },
  };

  try {
    await pool.query("SELECT 1");
    tests.db.status = "ok";
  } catch (error) {
    tests.db = { status: "fail", error: toErrorMessage(error) };
  }

  let userId: string | null = null;
  try {
    userId = crypto.randomUUID();
    const email = `system-check+${Date.now()}@example.com`;

    await pool.query(
      `
        INSERT INTO users (id, email, password_hash, role, active)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [userId, email, "system-check", "admin", true]
    );

    const read = await pool.query(
      `
        SELECT id
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    );

    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    userId = null;

    tests.users.status = (read.rowCount ?? 0) > 0 ? "ok" : "fail";
    if (tests.users.status === "fail") {
      tests.users.error = "inserted_user_not_found";
    }
  } catch (error) {
    tests.users = { status: "fail", error: toErrorMessage(error) };
    if (userId) {
      try {
        await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      } catch {
        // best-effort cleanup
      }
    }
  }

  try {
    const result = await pool.query("SELECT count(*)::int AS count FROM lenders");
    tests.lenders = { status: "ok", count: result.rows[0]?.count ?? 0 };
  } catch (error) {
    tests.lenders = { status: "fail", error: toErrorMessage(error) };
  }

  try {
    const result = await pool.query("SELECT count(*)::int AS count FROM lender_products");
    tests.products = { status: "ok", count: result.rows[0]?.count ?? 0 };
  } catch (error) {
    tests.products = { status: "fail", error: toErrorMessage(error) };
  }

  try {
    const phone = "+15555550123";
    const expected = tests.otp.expected;
    await storeOtp(phone, expected);
    const stored = await fetchOtp(phone);

    tests.otp.stored = stored;
    tests.otp.status = stored === expected ? "ok" : "fail";
  } catch (error) {
    tests.otp = {
      status: "fail",
      expected: tests.otp.expected,
      stored: null,
      error: toErrorMessage(error),
    };
  }

  const redis = getRedisOrNull();

  if (!redis) {
    tests.redis.status = "missing";
  } else {
    try {
      const key = `system-check:${Date.now()}`;
      const expected = "ok";
      await redis.set(key, expected, "EX", 30);
      const value = await redis.get(key);
      tests.redis.status = value === expected ? "ok" : "fail";
      if (tests.redis.status === "fail") {
        tests.redis.error = "redis_set_get_mismatch";
      }
      await redis.del(key);
    } catch (error) {
      tests.redis = { status: "fail", error: toErrorMessage(error) };
    }
  }

  const hasFailingTest = [
    tests.db.status,
    tests.users.status,
    tests.lenders.status,
    tests.products.status,
    tests.otp.status,
    tests.redis.status,
  ].some((status) => status === "fail");

  res.status(hasFailingTest ? 500 : 200).json({
    status: hasFailingTest ? "fail" : "ok",
    tests,
  });
});

export default systemCheckRouter;
