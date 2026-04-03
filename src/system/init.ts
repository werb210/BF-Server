import { pool } from "../db";
import { deps } from "./deps";

export async function initDependencies(): Promise<void> {
  let success = false;

  for (let i = 0; i < 3; i++) {
    try {
      await pool.query("SELECT 1");
      success = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  deps.db.ready = success;
}
