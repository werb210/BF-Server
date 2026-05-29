import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
const s = readFileSync("src/index.ts", "utf-8");
describe("v665 graceful worker shutdown", () => {
  it("captures every worker stop handle", () => {
    expect(s).toContain("const w = startOcrWorker(); workerStops.push(w.stop)");
    expect(s).toContain("const w = startBankingAutoWorker(pool); workerStops.push(w.stop)");
    expect(s).toContain("const w = startLenderPackageWorker(pool); workerStops.push(w.stop)");
  });
  it("registers SIGTERM/SIGINT that stops workers before pool.end()", () => {
    expect(s).toContain('process.on("SIGTERM"');
    expect(s).toContain('process.on("SIGINT"');
    const sd = s.indexOf("gracefulShutdown = async");
    const loop = s.indexOf("for (const stop of workerStops)", sd);
    const end = s.indexOf("await pool.end()", sd);
    expect(loop).toBeGreaterThan(sd);
    expect(end).toBeGreaterThan(loop); // workers stopped BEFORE pool drains
  });
});
