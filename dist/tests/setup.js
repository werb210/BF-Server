"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const db_1 = require("../db");
const redis_1 = require("../lib/redis");
const auth_routes_1 = require("../modules/auth/auth.routes");
(0, vitest_1.beforeAll)(async () => {
    if (process.env.SKIP_DB_CONNECTION === "true")
        return;
    try {
        await db_1.pool.query(`
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
    }
    catch (error) {
        console.warn("Skipping test schema bootstrap; database unavailable", error);
    }
});
(0, vitest_1.beforeEach)(() => {
    (0, redis_1.resetRedisMock)();
    (0, auth_routes_1.resetOtpStateForTests)();
});
