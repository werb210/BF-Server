// BF_SERVER_v870_CRM_DATA_MODEL - reports, the dashboard, activity lists and the assistant's staff tools see only the
// records the user may see, without rewriting their SQL (ported from KS-server #39 and #46).
//
// For a restricted user (Team or Own), scopedRequest() checks out one connection and creates TEMP views named
// applications, contacts and companies, plus the activity tables (communications_messages, communications_conversations,
// call_logs, call_events, voicemails, crm_call_log, tasks), on it that select only that user's visible rows from
// public.*. PostgreSQL searches the session's temp schema before public, so every unqualified table name in the SQL
// reads the filtered view. While the request runs, pool.query (the shared pool every module imports) is routed to that
// connection through AsyncLocalStorage, so nested services (report data, contact briefs, the pipeline query) are
// covered too. When the response ends the views are dropped and the connection goes back to the pool; if dropping
// fails the connection is destroyed instead, so a view can never reach another request. Work still running after the
// response (fire-and-forget automations) falls back to the shared pool.
//
// Users who see every record (everyone, until an Admin restricts someone) never take this path: no connection is
// checked out and no SQL changes. The silo filters in each query still apply on top of the views.
//
// No transaction is opened: each query autocommits exactly as it does on the shared pool.
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import type { Q } from "../settingsPack/common.js";
import { actingStaffFromRequest } from "../services/mayaActingStaff.js";
import { NOTHING_SCOPE, narrowToOwners, scopeForActingUser, scopeForRequest, teamOwnerIds, type RecordScope } from "./scope.js";

type Store = { client: PoolClient; queue: Promise<unknown>; closed: boolean };
const als = new AsyncLocalStorage<Store>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runOn(store: Store, args: unknown[]): Promise<any> {
  const run = store.queue.then(() => (store.client.query as any)(...args));
  store.queue = run.catch(() => undefined);
  return run;
}

let installed = false;
/**
 * Routes pool.query to the request's scoped connection while one is open. Idempotent. Callback-style calls pass through.
 * Installed the first time a restricted user's request opens scoped views, so while everyone sees every record (the
 * default) the shared pool is never touched.
 */
export function installScopedRouting(): void {
  if (installed) return;
  if (!pool || typeof (pool as any).query !== "function") return;
  installed = true;
  const original = (pool as any).query.bind(pool) as (...a: unknown[]) => unknown;
  (pool as any).query = (...args: unknown[]) => {
    const store = als.getStore();
    if (!store || store.closed || typeof args[args.length - 1] === "function") return original(...args);
    return runOn(store, args);
  };
}

/** The scoped request's connection (for code that streams with a client of its own), or null. */
export function currentScopedClient(): PoolClient | null {
  const store = als.getStore();
  return store && !store.closed ? store.client : null;
}

export function viewSql(ownerIds: string[], userId: string | null = null): string[] {
  const ids = ownerIds.filter((id) => UUID_RE.test(id));
  const lit = ids.length ? `ARRAY[${ids.map((id) => `'${id.toLowerCase()}'`).join(",")}]::uuid[]` : `ARRAY[]::uuid[]`;
  // Activity (messages, conversations, calls, call events, voicemails, tasks) linked to a contact, company or
  // application the user may not see is hidden too. Activity linked to nothing stays (unknown numbers). Tasks assigned
  // to the user always stay visible.
  const contactOk = (col: string) => `(${col} IS NULL OR EXISTS (SELECT 1 FROM public.contacts vc WHERE vc.id = ${col} AND vc.owner_id = ANY(${lit})))`;
  const companyOk = (col: string) => `(${col} IS NULL OR EXISTS (SELECT 1 FROM public.companies vo WHERE vo.id = ${col} AND vo.owner_id = ANY(${lit})))`;
  const appOk = (col: string) => `(${col} IS NULL OR EXISTS (SELECT 1 FROM public.applications va WHERE va.id::text = ${col}::text AND va.owner_user_id = ANY(${lit})))`;
  const me = userId && UUID_RE.test(userId) ? `'${userId.toLowerCase()}'::uuid` : null;
  return [
    `CREATE OR REPLACE TEMP VIEW applications AS SELECT * FROM public.applications WHERE owner_user_id = ANY(${lit})`,
    `CREATE OR REPLACE TEMP VIEW contacts AS SELECT * FROM public.contacts WHERE owner_id = ANY(${lit})`,
    `CREATE OR REPLACE TEMP VIEW companies AS SELECT * FROM public.companies WHERE owner_id = ANY(${lit})`,
    `CREATE OR REPLACE TEMP VIEW communications_messages AS SELECT * FROM public.communications_messages m WHERE ${contactOk("m.contact_id")} AND ${appOk("m.application_id")}`,
    `CREATE OR REPLACE TEMP VIEW communications_conversations AS SELECT * FROM public.communications_conversations cc WHERE ${contactOk("cc.contact_id")}`,
    `CREATE OR REPLACE TEMP VIEW call_logs AS SELECT * FROM public.call_logs cl WHERE ${contactOk("cl.contact_id")} AND ${contactOk("cl.crm_contact_id")} AND ${appOk("cl.application_id")}`,
    `CREATE OR REPLACE TEMP VIEW call_events AS SELECT * FROM public.call_events ce WHERE ${contactOk("ce.contact_id")} AND ${appOk("ce.application_id")}`,
    `CREATE OR REPLACE TEMP VIEW voicemails AS SELECT * FROM public.voicemails vm WHERE ${contactOk("vm.contact_id")} AND ${appOk("vm.application_id")}`,
    `CREATE OR REPLACE TEMP VIEW crm_call_log AS SELECT * FROM public.crm_call_log ccl WHERE ${contactOk("ccl.contact_id")}`,
    `CREATE OR REPLACE TEMP VIEW tasks AS SELECT * FROM public.tasks t WHERE ${me ? `t.assignee_user_id = ${me} OR ` : ""}(${contactOk("t.contact_id")} AND ${companyOk("t.company_id")})`,
  ];
}
export const DROP_VIEWS_SQL = `DROP VIEW IF EXISTS pg_temp.applications, pg_temp.contacts, pg_temp.companies, pg_temp.communications_messages, pg_temp.communications_conversations, pg_temp.call_logs, pg_temp.call_events, pg_temp.crm_call_log, pg_temp.voicemails, pg_temp.tasks`;

async function open(scope: RecordScope): Promise<Store> {
  installScopedRouting();
  const client = await pool.connect();
  try {
    const own = scope.mode === "restricted" && !scope.teamFilter ? scope.userId : null; // a team filter is not "my tasks"
    for (const sql of viewSql(scope.mode === "all" ? [] : scope.ownerIds, own)) await client.query(sql);
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  return { client, queue: Promise.resolve(), closed: false };
}

function close(store: Store): Promise<void> {
  if (store.closed) return Promise.resolve();
  store.closed = true;
  const { client } = store;
  return store.queue
    .then(() => client.query(DROP_VIEWS_SQL))
    .then(() => client.release(), (err) => {
      console.warn("[visibility] dropping scoped views failed; discarding the connection", (err as Error)?.message);
      client.release(err instanceof Error ? err : new Error(String(err)));
    });
}

/** Runs fn with pool.query limited to the scope (for code that is not a request handler, and tests). */
export async function runScoped<T>(scope: RecordScope, fn: () => Promise<T>): Promise<T> {
  if (scope.mode === "all") return fn();
  const store = await open(scope);
  try {
    return await als.run(store, fn);
  } finally {
    await close(store);
  }
}

/** The request's scope, narrowed to ?team_id= when given (a filter; an unknown team matches nothing). */
export async function scopeWithTeamFilter(req: Request, db: Q = pool as unknown as Q): Promise<RecordScope> {
  const scope = await scopeForRequest(req, db);
  const teamId = String((req.query as any)?.team_id ?? "").trim();
  if (!teamId) return scope;
  return narrowToOwners(scope, await teamOwnerIds(db, teamId));
}

function scopedMiddleware(resolve: (req: Request) => Promise<RecordScope>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const scope = await resolve(req);
      if (scope.mode === "all") { next(); return; }
      const store = await open(scope);
      res.once("finish", () => void close(store));
      res.once("close", () => void close(store));
      als.run(store, () => next());
    })().catch(next);
  };
}

/** After requireAuth: the rest of the request reads only the user's records (and ?team_id= narrows further). */
export const scopedRequest: RequestHandler = scopedMiddleware((req) => scopeWithTeamFilter(req));

/** scopedRequest for reads only (GET/HEAD); writes run as before. */
export const scopedReads: RequestHandler = (req: Request, res: Response, next: NextFunction) =>
  req.method === "GET" || req.method === "HEAD" ? scopedRequest(req, res, next) : next();

/**
 * The scope the assistant's staff tools read with: the staff member named in the X-Maya-Context this server signed
 * (BF_SERVER_v868_MAYA_ACTING_STAFF already refused a mismatch with 403). Without one (an agent build from before
 * v868) the assistant sees every record only while nobody is restricted; a bare staff_user_id or role in the body is
 * never used to widen what it sees.
 */
export async function scopeForAssistantRequest(req: Request, db: Q = pool as unknown as Q): Promise<RecordScope> {
  const acting = actingStaffFromRequest(req);
  if (acting.mismatch) return NOTHING_SCOPE;
  return scopeForActingUser(db, { staff_user_id: acting.id ?? "" });
}

/** For the assistant's staff routes (service token): reads limited to what the acting staff member may see. */
export const scopedAssistantRequest: RequestHandler = scopedMiddleware((r) => scopeForAssistantRequest(r));
