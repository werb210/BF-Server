// BF_SERVER_v784_PROCESS_HANDLERS - static check of the process-level handlers in src/index.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");

function handlerBody(event: string): string {
  const start = src.indexOf(`process.on("${event}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n});", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("src/index.ts process handlers", () => {
  it("registers each handler exactly once", () => {
    expect(src.split('process.on("uncaughtException"').length - 1).toBe(1);
    expect(src.split('process.on("unhandledRejection"').length - 1).toBe(1);
  });
  it("uncaughtException logs and exits 1", () => {
    const body = handlerBody("uncaughtException");
    expect(body).toContain("logFatal(");
    expect(body).toContain("process.exit(1)");
  });
  it("unhandledRejection logs only and does not exit", () => {
    const body = handlerBody("unhandledRejection");
    expect(body).toContain("logFatal(");
    expect(body).not.toContain("process.exit");
  });
  it("a failed start() logs and exits 1", () => {
    expect(src).not.toContain("start().catch(console.error)");
    const i = src.indexOf("start().catch(");
    expect(i).toBeGreaterThan(0);
    const tail = src.slice(i, i + 200);
    expect(tail).toContain("logFatal(");
    expect(tail).toContain("process.exit(1)");
  });
});
