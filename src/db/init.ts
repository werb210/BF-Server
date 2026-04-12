import { Pool } from "pg";

import { deps } from "../system/deps.js";

export async function initDb() {
  if (process.env.NODE_ENV === "test") {
    deps.db.ready = true;
    deps.db.client = {
      query: async () => ({ rows: [], rowCount: 1 }),
    };
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL missing");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  let connected = false;

  for (let i = 0; i < 3; i++) {
    try {
      await pool.query("SELECT 1");
      connected = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (connected) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS live_chat_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT,
        email TEXT,
        message TEXT,
        status TEXT DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
  }

  deps.db.ready = connected;
  deps.db.client = connected ? pool : null;
}
