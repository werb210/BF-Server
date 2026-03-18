import { pool } from "../db";

export async function initTestDb() {
  await pool.query("SELECT 1");
  return pool;
}

export async function closeTestDb() {
  // Shared test pool is managed by the main DB module.
}

export default initTestDb;
