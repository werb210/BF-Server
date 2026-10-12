// BF_SERVER_DEAD_LETTER_WORKER_v110
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { bootIndex, type Boot } from "../../__tests__/helpers/bootIndex.js";

const h = vi.hoisted(() => ({ query: vi.fn(), sendSms: vi.fn(), pushLeadToCRM: vi.fn() }));
vi.mock("../../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: (...a: unknown[]) => h.query(...a) } }));
vi.mock("../../modules/notifications/sms.service.js", () => ({ sendSms: (...a: unknown[]) => h.sendSms(...a) }));
vi.mock("../../services/crmWebhook.js", () => ({ pushLeadToCRM: (...a: unknown[]) => h.pushLeadToCRM(...a) }));
vi.mock("../../observability/alerts.js", () => ({ sendSlackAlert: async () => undefined }));
vi.mock("../claim.js", () => ({ claimedTick: (_n: string, fn: () => Promise<unknown>) => async () => { await fn(); } }));
import { processDeadLetters, startDeadLetterWorker } from "../deadLetterWorker.js";

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([], { rows: [], rowCount: 1 }));
  h.sendSms.mockReset();
  h.pushLeadToCRM.mockReset();
});

describe("dead-letter worker", () => {
  let boot: Boot | null = null;
  afterEach(() => { boot?.restore(); boot = null; vi.useRealTimers(); vi.restoreAllMocks(); });

  it("is started at boot", async () => {
    boot = await bootIndex();
    await boot.workersDone();
    expect(boot.workerCalls.get("startDeadLetterWorker")).toEqual([[]]); // it reaches the pool itself
    expect(boot.logText("log")).toContain("[startup] dead-letter worker started");
  });

  it("is registered for shutdown like every other worker", async () => {
    boot = await bootIndex();
    await boot.workersDone();
    boot.handlers.get("SIGTERM")![0]();
    await vi.waitFor(() => expect(boot!.exitCodes).toEqual([0]));
    const ev = boot.events;
    expect(ev).toContain("stop:startDeadLetterWorker");
    expect(ev.indexOf("stop:startDeadLetterWorker")).toBeLessThan(ev.indexOf("pool.end"));
  });

  it("returns the { stop } shape index.ts expects, and stop clears the timer", async () => {
    vi.useFakeTimers();
    const w = startDeadLetterWorker();
    expect(typeof w.stop).toBe("function");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(callsMatching(h.query, /SELECT \* FROM failed_jobs/)).toHaveLength(1);
    w.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callsMatching(h.query, /SELECT \* FROM failed_jobs/)).toHaveLength(1);
  });

  it("does not hold the process open", () => {
    const unref = vi.fn();
    const handle = { unref, ref: vi.fn(), hasRef: () => false };
    const si = vi.spyOn(globalThis, "setInterval").mockImplementation((() => handle) as any);
    const ci = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    const w = startDeadLetterWorker();
    expect(si.mock.calls[0][1]).toBe(15_000);
    expect(unref).toHaveBeenCalledTimes(1);
    w.stop();
    expect(ci).toHaveBeenCalledWith(handle);
  });

  it("a start failure does not take down boot", async () => {
    boot = await bootIndex({ failWorkers: ["startDeadLetterWorker"] });
    await boot.workersDone();
    expect(boot.logText("error")).toContain("[startup] dead-letter worker failed to start:");
    // The workers after it still start, and boot finishes.
    expect(boot.started()).toContain("startSequenceWorker");
    expect(boot.started()).toContain("startLenderBounceWorker");
    expect(boot.exitCodes).toEqual([]);
  });

  it("still respects the retry cap and the prune", async () => {
    h.pushLeadToCRM.mockRejectedValue(new Error("crm down"));
    h.query.mockImplementation(answerBySql([
      [/SELECT \* FROM failed_jobs/, { rows: [{ id: "j1", retry_count: 3, type: "partner_webhook", data: {} }] }],
    ], { rows: [], rowCount: 1 }));
    await processDeadLetters();
    const select = callsMatching(h.query, /SELECT \* FROM failed_jobs/)[0];
    expect(String(select[0])).toContain("WHERE retry_count < $1");
    expect(select[1]).toEqual([10]);
    const prune = callsMatching(h.query, /DELETE FROM failed_jobs WHERE retry_count >= \$1/)[0];
    expect(String(prune[0])).toContain("interval '7 days'");
    expect(prune[1]).toEqual([10]);
    // A failed retry bumps the count; it is not deleted.
    expect(callsMatching(h.query, /SET retry_count = retry_count \+ 1/)[0][1]).toEqual(["j1"]);
    expect(callsMatching(h.query, /DELETE FROM failed_jobs WHERE id = \$1/)).toHaveLength(0);
  });

  it("a permanent SMS failure is retired at the cap", async () => {
    h.sendSms.mockRejectedValue(Object.assign(new Error("invalid"), { code: 21211 }));
    h.query.mockImplementation(answerBySql([
      [/SELECT \* FROM failed_jobs/, { rows: [{ id: "j2", retry_count: 0, type: "sms", data: { to: "+14038721234", body: "hi" } }] }],
    ], { rows: [], rowCount: 1 }));
    await processDeadLetters();
    expect(callsMatching(h.query, /UPDATE failed_jobs SET retry_count = \$2 WHERE id = \$1/)[0][1]).toEqual(["j2", 10]);
  });
});
