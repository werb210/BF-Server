import { beforeAll, beforeEach } from "vitest";

import { pool } from "../db";
import { resetRedisMock } from "../lib/redis";
import { resetTestDb } from "../lib/db.test";
import { resetOtpStateForTests } from "../modules/auth/auth.routes";

beforeAll(async () => {
  if (process.env.SKIP_DB_CONNECTION === "true") return;

  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE,
      silo TEXT
    );

    CREATE TABLE IF NOT EXISTS lenders (
      id SERIAL PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      status TEXT
    );
  `);
  } catch (error) {
    console.warn("Skipping test schema bootstrap; database unavailable", error);
  }
});

beforeEach(() => {
  resetTestDb();
  resetRedisMock();
  resetOtpStateForTests();
});
