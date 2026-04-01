import { ensureDb } from "../db";
import { deps } from "./deps";

export async function initDependencies() {
  try {
    await ensureDb();
    deps.db.ready = true;
    deps.db.error = null;
  } catch (err) {
    deps.db.ready = false;
    deps.db.error = err;
    console.error("[DB INIT FAILED]", err);
  }
}
