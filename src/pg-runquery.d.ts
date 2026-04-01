import type { QueryResult, QueryResultRow } from "pg";

declare module "pg" {
  interface Pool {
    runQuery<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>>;
  }

  interface PoolClient {
    runQuery<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>>;
  }
}
