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

  deps.db.ready = connected;
  deps.db.client = connected ? pool : null;
}
