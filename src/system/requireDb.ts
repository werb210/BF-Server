import { deps } from "./deps.js";

export function requireDb() {
  if (!deps.db.ready) {
    const err: any = new Error("DB_NOT_READY");
    err.status = 503;
    throw err;
  }
}
