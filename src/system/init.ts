import { pool, runQuery } from "../db";
import { deps } from "./deps";

async function tryConnect(retries = 5): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await runQuery("select 1");
      return true;
    } catch (err) {
      deps.db.error = err;
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  return false;
}

export async function initDependencies() {
  deps.db.ready = await tryConnect();
  if (deps.db.ready) {
    deps.db.error = null;
  } else {
    console.error("[DB INIT FAILED]", deps.db.error);
  }
}
