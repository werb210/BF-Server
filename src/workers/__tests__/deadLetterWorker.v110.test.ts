// BF_SERVER_DEAD_LETTER_WORKER_v110
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = (...p: string[]) => readFileSync(resolve(__dirname, ...p), "utf-8");
const worker = R("..", "deadLetterWorker.ts");
const index = R("..", "..", "index.ts");

describe("dead-letter worker", () => {
  it("is started at boot", () => {
    expect(index).toContain("startDeadLetterWorker");
    expect(index).toContain("[startup] dead-letter worker started");
  });

  it("is registered for shutdown like every other worker", () => {
    const i = index.indexOf("startDeadLetterWorker()");
    expect(index.slice(i, i + 200)).toContain("workerStops.push(w.stop)");
  });

  it("returns the { stop } shape index.ts expects", () => {
    expect(worker).toContain("): { stop: () => void } {");
    expect(worker).toContain("clearInterval(timer)");
  });

  it("does not hold the process open", () => {
    expect(worker).toContain("timer.unref()");
  });

  it("a start failure does not take down boot", () => {
    const i = index.indexOf("startDeadLetterWorker()");
    expect(index.slice(i - 120, i + 260)).toContain("catch (err)");
  });

  it("still respects the retry cap and the prune", () => {
    expect(worker).toContain("MAX_RETRIES = 10");
    expect(worker).toContain("interval '7 days'");
  });
});
