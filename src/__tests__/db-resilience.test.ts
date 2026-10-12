import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js"; // BF_SERVER_v789_SQL_CONTENT_MOCKS

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
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
  });

  it("keeps server alive when DB is unavailable during init", async () => {
    const { deps } = await import("../system/deps.js");
    deps.db.ready = false;
    deps.db.error = null;
    queryMock.mockRejectedValue(new Error("offline"));
    const { initDependencies } = await import("../system/init.js");

    await expect(initDependencies()).resolves.toBeUndefined();
    expect(deps.db.ready).toBe(false);
  });

  it("marks DB ready when connectivity succeeds before retries are exhausted", async () => {
    const { deps } = await import("../system/deps.js");
    deps.db.ready = false;
    deps.db.error = null;
    // BF_SERVER_v789_SQL_CONTENT_MOCKS - the connectivity ping (SELECT 1) is offline for its first two attempts.
    let pings = 0;
    queryMock.mockImplementation(answerBySql([
      [/^SELECT 1$/, () => (++pings <= 2 ? new Error("offline") : { rows: [] })],
    ], new Error("unexpected query")));
    const { initDependencies } = await import("../system/init.js");

    await initDependencies();
    expect(deps.db.ready).toBe(true);
    expect(callsMatching(queryMock, /^SELECT 1$/)).toHaveLength(3);
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it("throws a 503 error when querying while DB is not ready", async () => {
    const { deps } = await import("../system/deps.js");
    deps.db.ready = false;
    deps.db.error = null;
    const { safeQuery } = await import("../db.js");
    await expect(safeQuery("select 1")).rejects.toMatchObject({
      message: "DB_NOT_READY",
      status: 503,
    });
  });
});
