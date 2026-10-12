// BF_SERVER_v789_WORKER_CLAIM - cross-instance claim for background workers.
//
// Every App Service instance (production, the staging slot during a swap, a
// scaled-out second instance) starts the same setInterval workers. The
// in-process `running` flag only stops a tick overlapping itself; two instances
// still ran the same tick at the same time and both sent the same SMS / email /
// Google Ads upload. withWorkerLock(name, fn) takes a Postgres session advisory
// lock (pg_try_advisory_lock, non-blocking) named after the worker before fn
// runs; an instance that does not get it skips this tick instead of
// double-sending. The lock is released in finally.
//
// The locks live on ONE dedicated session per process (checked out of the pool
// once and kept), not on a pooled client per tick: the pool has max 10 and a
// client held for the length of every long tick (Google Ads, Graph, OpenAI)
// would starve HTTP traffic. If that session dies, Postgres drops its locks
// with it; the session is discarded and a fresh one is taken on the next claim.
// If the lock cannot be checked at all (database unreachable), the tick is
// skipped - failing closed is what prevents a double send.
import type { Pool, PoolClient } from "pg";

// int4 namespace for the two-key advisory-lock form, so worker locks can never
// collide with the migration lock (single bigint key) or hashtext() locks.
export const WORKER_LOCK_CLASS = 789_001;

export type WorkerLockResult<T> =
  | { ran: true; result: T }
  | { ran: false; reason: "held_elsewhere" | "held_here" | "lock_unavailable" };

export type WorkerLock = {
  withWorkerLock<T>(name: string, fn: () => Promise<T>): Promise<WorkerLockResult<T>>;
  close(): Promise<void>;
};

function errMessage(err: unknown): string {
  return (err as { message?: string } | null)?.message ?? String(err);
}

export function createWorkerLock(getPool: () => Pool | Promise<Pool>): WorkerLock {
  let session: PoolClient | null = null;
  let connecting: Promise<PoolClient> | null = null;
  const heldHere = new Set<string>();

  function discard(c: PoolClient, err?: unknown): void {
    if (session === c) session = null;
    try {
      // release(err) destroys the connection instead of returning it to the pool.
      c.release(err instanceof Error ? err : new Error("worker_lock_session_discarded"));
    } catch (releaseErr) {
      console.warn("[worker-lock] discarding the lock session failed", { message: errMessage(releaseErr) });
    }
  }

  async function getSession(): Promise<PoolClient> {
    if (session) return session;
    if (!connecting) {
      connecting = (async () => {
        const pool = await getPool();
        const c = await pool.connect();
        c.on("error", (err: Error) => {
          console.warn("[worker-lock] lock session error; locks on it are gone, reconnecting on next claim", { message: errMessage(err) });
          if (session === c) discard(c, err);
        });
        session = c;
        return c;
      })();
      connecting.then(
        () => { connecting = null; },
        () => { connecting = null; },
      );
    }
    return connecting;
  }

  async function withWorkerLock<T>(name: string, fn: () => Promise<T>): Promise<WorkerLockResult<T>> {
    // Session advisory locks are re-entrant within one session, so the
    // in-process guard is what stops this process claiming the same name twice.
    if (heldHere.has(name)) return { ran: false, reason: "held_here" };
    heldHere.add(name);
    let c: PoolClient;
    try {
      c = await getSession();
      const r = await c.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked",
        [WORKER_LOCK_CLASS, name],
      );
      if (r.rows[0]?.locked !== true) {
        heldHere.delete(name);
        return { ran: false, reason: "held_elsewhere" };
      }
    } catch (err) {
      heldHere.delete(name);
      console.warn("[worker-lock] could not claim; skipping this tick", { worker: name, message: errMessage(err) });
      return { ran: false, reason: "lock_unavailable" };
    }
    try {
      return { ran: true, result: await fn() };
    } finally {
      try {
        await c.query("SELECT pg_advisory_unlock($1, hashtext($2))", [WORKER_LOCK_CLASS, name]);
      } catch (err) {
        // The session is unusable; destroying it is what releases the lock server-side.
        console.warn("[worker-lock] unlock failed; discarding the lock session", { worker: name, message: errMessage(err) });
        discard(c, err);
      }
      heldHere.delete(name);
    }
  }

  async function close(): Promise<void> {
    const c = session ?? (connecting ? await connecting.catch(() => null) : null);
    session = null;
    if (!c) return;
    try {
      await c.query("SELECT pg_advisory_unlock_all()");
    } catch (err) {
      console.warn("[worker-lock] unlock_all on close failed", { message: errMessage(err) });
    }
    try { c.release(); } catch (err) { console.warn("[worker-lock] release on close failed", { message: errMessage(err) }); }
  }

  return { withWorkerLock, close };
}

const shared = createWorkerLock(async () => (await import("../db.js")).pool);

/** Run fn only if no other instance is running the worker `name` right now. */
export function withWorkerLock<T>(name: string, fn: () => Promise<T>): Promise<WorkerLockResult<T>> {
  return shared.withWorkerLock(name, fn);
}

/**
 * Wrap a worker's tick so it runs under withWorkerLock(name). The returned
 * function never rejects (it is called as `void tick()` from timers).
 */
export function claimedTick(name: string, fn: () => Promise<unknown>, lock: Pick<WorkerLock, "withWorkerLock"> = shared): () => Promise<void> {
  return async () => {
    try {
      await lock.withWorkerLock(name, fn);
    } catch (err) {
      console.error("[worker-lock] tick failed", { worker: name, message: errMessage(err) });
    }
  };
}

/** Return the lock session to the pool (graceful shutdown, before pool.end()). */
export function closeWorkerLocks(): Promise<void> {
  return shared.close();
}
