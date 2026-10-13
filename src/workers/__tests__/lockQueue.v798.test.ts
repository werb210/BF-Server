// BF_SERVER_v798_LOCK_SESSION_QUEUE
// All workers share one lock session and their ticks fire together. Lock and unlock queries on that
// session must never overlap (pg deprecation; an error in pg@9), and every worker still gets its turn.
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createWorkerLock } from "../claim.js";

describe("worker lock session queue", () => {
  it("sends one query at a time on the shared session while 10 workers claim at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const session = {
      on: vi.fn(),
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return /pg_try_advisory_lock/.test(sql) ? { rows: [{ locked: true }] } : { rows: [] };
      }),
    };
    const pool = { connect: vi.fn(async () => session) } as unknown as Pool;
    const lock = createWorkerLock(() => pool);
    const ran: string[] = [];
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => lock.withWorkerLock(`w${i}`, async () => { ran.push(`w${i}`); return i; })));
    expect(maxInFlight).toBe(1);
    expect(results.every((r) => r.ran)).toBe(true);
    expect(ran).toHaveLength(10);
    expect(session.query).toHaveBeenCalledTimes(20);
  });

  it("a failed query does not jam the queue for the next worker", async () => {
    let calls = 0;
    const session = {
      on: vi.fn(),
      release: vi.fn(),
      query: vi.fn(async () => { calls += 1; if (calls === 1) throw new Error("read ETIMEDOUT"); return { rows: [{ locked: true }] }; }),
    };
    const pool = { connect: vi.fn(async () => session) } as unknown as Pool;
    const lock = createWorkerLock(() => pool);
    expect(await lock.withWorkerLock("a", async () => 1)).toEqual({ ran: false, reason: "lock_unavailable" });
    expect(await lock.withWorkerLock("b", async () => 2)).toEqual({ ran: true, result: 2 });
  });
});
