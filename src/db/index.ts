import type { QueryResult } from "pg";

import { deps } from "@/system/deps";

export async function runQuery<T = unknown>(text: string, params?: any[]): Promise<QueryResult<T>> {
  if (!deps.db.ready) {
    throw Object.assign(new Error("DB_NOT_READY"), { status: 503 });
  }

  return deps.db.client.query(text, params);
}
