import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assertPoolHealthy,
  checkDb,
  pool,
  setDbTestPoolMetricsOverride,
  warmUpDatabase,
} from "../db";

describe("database connectivity", () => {
  it("runs a simple connection check", async () => {
    const spy = vi
      .spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await checkDb();

    expect(spy).toHaveBeenCalledWith("select 1");
    spy.mockRestore();
  });

  it("fails fast when warm-up cannot reach the database", async () => {
    const spy = vi
      .spyOn(pool, "query")
      .mockImplementationOnce(() =>
        Promise.reject(new Error("db unavailable"))
      );

    await expect(warmUpDatabase()).rejects.toThrow("db unavailable");

    spy.mockRestore();
  });

  it("detects pool exhaustion", () => {
    setDbTestPoolMetricsOverride({
      waitingCount: 1,
      totalCount: 2,
      max: 2,
    });

    expect(() => assertPoolHealthy()).toThrow("db_pool_exhausted");

    setDbTestPoolMetricsOverride(null);
  });
});
