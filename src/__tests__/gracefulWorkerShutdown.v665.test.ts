// BF_SERVER_BLOCK_v665 - graceful worker shutdown, exercised by booting src/index.ts with stubbed workers.
import { afterEach, describe, it, expect, vi } from "vitest";
import { bootIndex, WORKER_MODULES, type Boot } from "./helpers/bootIndex.js";

let boot: Boot | null = null;
afterEach(() => { boot?.restore(); boot = null; });

describe("v665 graceful worker shutdown", () => {
  it("captures every worker stop handle", async () => {
    boot = await bootIndex();
    await boot.workersDone();
    expect(boot.started()).toEqual(expect.arrayContaining(["startOcrWorker", "startBankingAutoWorker", "startLenderPackageWorker"]));
    await boot.handlers.get("SIGTERM")![0]();
    await vi.waitFor(() => expect(boot!.exitCodes).toEqual([0]));
    const stopped = boot.events.filter((e) => e.startsWith("stop:")).map((e) => e.slice(5));
    // Every worker that returned a { stop } handle is stopped (the graph subscription returns a timer instead).
    const withStop = WORKER_MODULES.map(([, n]) => n).filter((n) => n !== "startGraphSubscriptionWorker");
    expect(stopped.sort()).toEqual([...withStop].sort());
  });

  it("registers SIGTERM/SIGINT that stops workers before pool.end()", async () => {
    boot = await bootIndex();
    await boot.workersDone();
    expect(boot.handlers.get("SIGTERM")).toHaveLength(1);
    expect(boot.handlers.get("SIGINT")).toHaveLength(1);

    boot.handlers.get("SIGINT")![0]();
    await vi.waitFor(() => expect(boot!.exitCodes).toEqual([0]));
    const ev = boot.events;
    const lastStop = Math.max(...ev.map((e, i) => (e.startsWith("stop:") ? i : -1)));
    const end = ev.indexOf("pool.end");
    expect(lastStop).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(lastStop); // workers stopped BEFORE pool drains
    expect(ev.indexOf("closeWorkerLocks")).toBeGreaterThan(lastStop);
    expect(ev.indexOf("closeWorkerLocks")).toBeLessThan(end);
    expect(ev.indexOf("exit:0")).toBeGreaterThan(end);
  });

  it("a second signal does not run the shutdown twice", async () => {
    boot = await bootIndex();
    await boot.workersDone();
    boot.handlers.get("SIGTERM")![0]();
    boot.handlers.get("SIGINT")![0]();
    await vi.waitFor(() => expect(boot!.exitCodes).toEqual([0]));
    expect(boot.pool.end).toHaveBeenCalledTimes(1);
  });
});
