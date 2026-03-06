import { randomUUID } from "crypto";
import { pool } from "../../db";
import { type PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

export type IdempotencyRecord = {
  id: string;
  key: string;
  route: string;
  request_hash: string | null;
  response_code: number;
  response_body: unknown;
  created_at: Date;
};

export async function findIdempotencyRecord(params: {
  route: string;
  idempotencyKey: string;
  client?: Queryable;
}): Promise<IdempotencyRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<IdempotencyRecord>(
    `select id, key, route, request_hash, response_code, response_body, created_at
     from idempotency_keys
     where route = $1
       and key = $2
       and created_at >= (localtimestamp - interval '24 hours')
     limit 1`,
    [params.route, params.idempotencyKey]
  );
  return res.rows[0] ?? null;
}

export async function deleteExpiredIdempotencyRecord(params: {
  route: string;
  idempotencyKey: string;
  client?: Queryable;
}): Promise<void> {
  const runner = params.client ?? pool;
  await runner.query(
    `delete from idempotency_keys
     where route = $1
       and key = $2
       and created_at < (localtimestamp - interval '24 hours')`,
    [params.route, params.idempotencyKey]
  );
}

export async function purgeExpiredIdempotencyKeys(client?: Queryable): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `delete from idempotency_keys
     where created_at < (localtimestamp - interval '24 hours')`
  );
}

function isUndefinedColumnError(error: unknown, column: string): boolean {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return code === "42703" || message.includes(column.toLowerCase());
}

export async function createIdempotencyRecord(params: {
  route: string;
  idempotencyKey: string;
  requestHash: string;
  responseCode: number;
  responseBody: unknown;
  method?: string | null;
  client?: Queryable;
}): Promise<void> {
  const runner = params.client ?? pool;
  const id = randomUUID();
  if (params.method) {
    try {
      await runner.query(
        `insert into idempotency_keys
         (id, key, route, method, request_hash, response_code, response_body, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (route, key) do update
         set request_hash = excluded.request_hash,
             response_code = excluded.response_code,
             response_body = excluded.response_body,
             created_at = now()`,
        [
          id,
          params.idempotencyKey,
          params.route,
          params.method,
          params.requestHash,
          params.responseCode,
          params.responseBody,
        ]
      );
      return;
    } catch (error) {
      if (!isUndefinedColumnError(error, "method")) {
        throw error;
      }
    }
  }
  try {
    await runner.query(
      `insert into idempotency_keys
       (id, key, route, request_hash, response_code, response_body, created_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (route, key) do update
       set request_hash = excluded.request_hash,
           response_code = excluded.response_code,
           response_body = excluded.response_body,
           created_at = now()`,
      [
        id,
        params.idempotencyKey,
        params.route,
        params.requestHash,
        params.responseCode,
        params.responseBody,
      ]
    );
    return;
  } catch (error) {
    if (!isUndefinedColumnError(error, "request_hash") && !isUndefinedColumnError(error, "response_code") && !isUndefinedColumnError(error, "response_body") && !isUndefinedColumnError(error, "id")) {
      throw error;
    }
  }

  await runner.query(
    `insert into idempotency_keys
     (key, route, response, created_at)
     values ($1, $2, $3, now())
     on conflict (route, key) do update
     set response = excluded.response,
         created_at = now()`,
    [
      params.idempotencyKey,
      params.route,
      JSON.stringify(params.responseBody ?? null),
    ]
  );
}
