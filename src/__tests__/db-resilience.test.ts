import { beforeEach, describe, expect, it, vi } from "vitest";

import { deps } from "../system/deps";
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db")>("../db");
  return {
    ...actual,
    pool: {
      query: queryMock,
    },
  };
});

describe("db resilience", () => {
  beforeEach(() => {
    queryMock.mockReset();
    deps.db.ready = false;
    deps.db.error = null;
  });

  it("keeps server alive when DB is unavailable during init", async () => {
    queryMock.mockRejectedValue(new Error("offline"));
    const { initDependencies } = await import("../system/init");

    await expect(initDependencies()).resolves.toBeUndefined();
    expect(deps.db.ready).toBe(false);
  });

  it("marks DB ready when connectivity succeeds before retries are exhausted", async () => {
    queryMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ rows: [] });
    const { initDependencies } = await import("../system/init");

    await initDependencies();
    expect(deps.db.ready).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it("throws a 503 error when querying while DB is not ready", async () => {
    const { safeQuery } = await import("../db");
    await expect(safeQuery("select 1")).rejects.toMatchObject({
      message: "DB_NOT_READY",
      status: 503,
    });
  });
});
