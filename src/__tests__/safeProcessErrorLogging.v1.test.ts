// BF_SERVER_SAFE_PROCESS_ERROR_LOGGING_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const errors = read("src/system/errors.ts");
const index = read("src/index.ts");

describe("process error handlers never log a raw error object", () => {
  it("errors.ts no longer passes the error object to console.error", () => {
    // `console.error(tag, e)` on a pg error dumps the live Client: user, host,
    // database, processID and secretKey.
    expect(errors).not.toContain('console.error("[UNCAUGHT EXCEPTION]", e)');
    expect(errors).not.toContain('console.error("[UNHANDLED REJECTION]", e)');
  });

  it("errors.ts redacts to message + code + stack", () => {
    expect(errors).toContain("function safeLog");
    expect(errors).toContain("String(e?.message ?? err) + code");
    expect(errors).toContain("if (e?.stack) console.error(e.stack)");
  });

  it("index.ts keeps its own redaction", () => {
    expect(index).toContain("function logFatal");
    expect(index).toContain("String(e?.message ?? err) + code");
  });

  it("handlers stay registered so an uncaught error does not exit the process", () => {
    expect(errors).toContain('process.on("uncaughtException"');
    expect(errors).toContain('process.on("unhandledRejection"');
    expect(errors).not.toContain("process.exit");
  });
});
