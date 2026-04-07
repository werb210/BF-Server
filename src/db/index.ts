import type { QueryResult, QueryResultRow } from "pg";

import { deps } from "../system/deps";

export async function runQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[],
): Promise<QueryResult<T>> {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("runQuery requires a non-empty SQL query string");
  }

  if (Array.isArray(params) && params.some((value) => value === undefined)) {
    throw new Error("runQuery params must not include undefined");
  }

  if (!deps.db.ready) {
    if (process.env.DATABASE_URL) {
      throw Object.assign(new Error("DB_NOT_READY"), { status: 503 });
    }
    throw Object.assign(new Error("DB_POOL_NOT_INITIALIZED"), { status: 503 });
  }

  if (!deps.db.client) {
    throw Object.assign(new Error("DB_POOL_NOT_INITIALIZED"), { status: 503 });
  }

  return deps.db.client.query(text, params);
}
