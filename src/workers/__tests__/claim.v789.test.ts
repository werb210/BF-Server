// BF_SERVER_v789_WORKER_CLAIM - withWorkerLock: a second instance (or a second
// concurrent run) skips the tick instead of running it. The fake Postgres keeps
// advisory locks per session and answers by SQL content.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { claimedTick, createWorkerLock, WORKER_LOCK_CLASS } from "../claim.js";

type FakeServer = { locks: Map<string, number>; sessions: number; queries: string[] };

function fakeServer(): FakeServer {
  return { locks: new Map(), sessions: 0, queries: [] };
}

function fakePool(server: FakeServer, opts: { failConnect?: boolean } = {}) {
  const pool = {
    connect: vi.fn(async () => {
      if (opts.failConnect) throw new Error("connect ETIMEDOUT");
      const session = ++server.sessions;
      return {
        on: vi.fn(),
        release: vi.fn(),
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          server.queries.push(sql);
          const key = `${params[0]}:${params[1]}`;
          if (/pg_try_advisory_lock/i.test(sql)) {
            expect(params[0]).toBe(WORKER_LOCK_CLASS);
            const owner = server.locks.get(key);
            if (owner === undefined || owner === session) {
              server.locks.set(key, session);
              return { rows: [{ locked: true }] };
            }
            return { rows: [{ locked: false }] };
          }
          if (/pg_advisory_unlock_all/i.test(sql)) {
            for (const [k, v] of server.locks) if (v === session) server.locks.delete(k);
            return { rows: [] };
          }
          if (/pg_advisory_unlock/i.test(sql)) {
            if (server.locks.get(key) === session) server.locks.delete(key);
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          return { rows: [] };
        }),
      };
    }),
    query: vi.fn(),
  };
  return pool as unknown as Pool;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("withWorkerLock", () => {
  it("a second instance skips while the first is running, then can run afterwards", async () => {
    const server = fakeServer();
    const a = createWorkerLock(() => fakePool(server));
    const b = createWorkerLock(() => fakePool(server));
    const gate = deferred();
    const sends: string[] = [];

    const first = a.withWorkerLock("sms_cascade", async () => { await gate.promise; sends.push("a"); return 1; });
    // let A take the lock
    await vi.waitFor(() => expect(server.locks.size).toBe(1));

    const second = await b.withWorkerLock("sms_cascade", async () => { sends.push("b"); return 2; });
    expect(second).toEqual({ ran: false, reason: "held_elsewhere" });

    gate.resolve();
    expect(await first).toEqual({ ran: true, result: 1 });
    expect(sends).toEqual(["a"]);
    expect(server.locks.size).toBe(0);

    const third = await b.withWorkerLock("sms_cascade", async () => { sends.push("b"); return 3; });
    expect(third).toEqual({ ran: true, result: 3 });
    expect(sends).toEqual(["a", "b"]);
  });

  it("the same process cannot run the same worker twice at once (advisory locks are re-entrant per session)", async () => {
    const server = fakeServer();
    const a = createWorkerLock(() => fakePool(server));
    const gate = deferred();
    const first = a.withWorkerLock("ad_conversion", () => gate.promise);
    const second = await a.withWorkerLock("ad_conversion", async () => "nope");
    expect(second).toEqual({ ran: false, reason: "held_here" });
    gate.resolve();
    expect((await first).ran).toBe(true);
  });

  it("different workers do not block each other", async () => {
    const server = fakeServer();
    const a = createWorkerLock(() => fakePool(server));
    const b = createWorkerLock(() => fakePool(server));
    const gate = deferred();
    const first = a.withWorkerLock("sms_cascade", () => gate.promise);
    await vi.waitFor(() => expect(server.locks.size).toBe(1));
    const other = await b.withWorkerLock("ad_conversion", async () => "ok");
    expect(other).toEqual({ ran: true, result: "ok" });
    gate.resolve();
    await first;
  });

  it("releases the lock when the tick throws", async () => {
    const server = fakeServer();
    const a = createWorkerLock(() => fakePool(server));
    await expect(a.withWorkerLock("x", async () => { throw new Error("tick blew up"); })).rejects.toThrow("tick blew up");
    expect(server.locks.size).toBe(0);
    const again = await a.withWorkerLock("x", async () => "ran");
    expect(again.ran).toBe(true);
  });

  it("fails closed: if the lock cannot be checked, the tick is skipped", async () => {
    const server = fakeServer();
    const a = createWorkerLock(() => fakePool(server, { failConnect: true }));
    const fn = vi.fn(async () => "sent");
    const out = await a.withWorkerLock("sms_cascade", fn);
    expect(out).toEqual({ ran: false, reason: "lock_unavailable" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("uses one dedicated session for all claims (never a pooled client per tick)", async () => {
    const server = fakeServer();
    const pool = fakePool(server);
    const a = createWorkerLock(() => pool);
    await a.withWorkerLock("one", async () => 1);
    await a.withWorkerLock("two", async () => 2);
    await a.withWorkerLock("one", async () => 3);
    expect((pool as any).connect).toHaveBeenCalledTimes(1);
    expect((pool as any).query).not.toHaveBeenCalled();
    await a.close();
  });
});

describe("claimedTick", () => {
  it("never rejects and skips the body when another instance holds the lock", async () => {
    const server = fakeServer();
    const a = createWorkerLock(() => fakePool(server));
    const b = createWorkerLock(() => fakePool(server));
    const gate = deferred();
    const bodyA = vi.fn(() => gate.promise);
    const bodyB = vi.fn(async () => undefined);
    const tickA = claimedTick("send_queue_like", bodyA, a);
    const tickB = claimedTick("send_queue_like", bodyB, b);
    const runA = tickA();
    await vi.waitFor(() => expect(server.locks.size).toBe(1));
    await tickB();
    expect(bodyB).not.toHaveBeenCalled();
    gate.resolve();
    await runA;
    expect(bodyA).toHaveBeenCalledTimes(1);

    const boom = claimedTick("boom", async () => { throw new Error("x"); }, a);
    await expect(boom()).resolves.toBeUndefined();
  });
});
