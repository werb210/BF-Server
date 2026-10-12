// BF_SERVER_SAFE_PROCESS_ERROR_LOGGING_v1
// `console.error(tag, e)` on a pg error dumps the live Client: user, host,
// database, processID and secretKey. Both sets of process handlers (src/system/errors.ts
// and src/index.ts) must log message + code + stack only.
import { afterEach, describe, it, expect, vi } from "vitest";
import { bootIndex, type Boot } from "./helpers/bootIndex.js";

function pgLikeError(): Error {
  const err = new Error("Connection terminated due to connection timeout") as Error & Record<string, unknown>;
  err.code = "ETIMEDOUT";
  err.client = { user: "borealadmin", host: "db.example", processID: 219587, secretKey: -1853604146 };
  return err;
}

function assertRedacted(calls: unknown[][], tag: string): void {
  // Every argument is a string: the raw error object (and its client) never reaches the log.
  for (const args of calls) for (const a of args) expect(typeof a).toBe("string");
  const text = calls.map((c) => c.join(" ")).join("\n");
  expect(text).toContain(`${tag} Connection terminated due to connection timeout (ETIMEDOUT)`);
  expect(text).toContain("at "); // the stack is still logged
  expect(text).not.toContain("secretKey");
  expect(text).not.toContain("1853604146");
}

async function loadErrorsModule() {
  const handlers = new Map<string, (e: unknown) => void>();
  const on = vi.spyOn(process, "on").mockImplementation(((event: string, fn: (e: unknown) => void) => {
    handlers.set(event, fn);
    return process;
  }) as any);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as any);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.resetModules();
  await import("../system/errors.js");
  on.mockRestore();
  return { handlers, exit, error };
}

let boot: Boot | null = null;
afterEach(() => { boot?.restore(); boot = null; vi.restoreAllMocks(); });

describe("process error handlers never log a raw error object", () => {
  it("errors.ts does not pass the error object to console.error", async () => {
    const { handlers, error } = await loadErrorsModule();
    handlers.get("uncaughtException")!(pgLikeError());
    handlers.get("unhandledRejection")!(pgLikeError());
    for (const args of error.mock.calls) for (const a of args) expect(a).not.toBeInstanceOf(Error);
  });

  it("errors.ts redacts to message + code + stack", async () => {
    const { handlers, error } = await loadErrorsModule();
    handlers.get("uncaughtException")!(pgLikeError());
    assertRedacted(error.mock.calls, "[UNCAUGHT EXCEPTION]");
    error.mockClear();
    handlers.get("unhandledRejection")!(pgLikeError());
    assertRedacted(error.mock.calls, "[UNHANDLED REJECTION]");
    error.mockClear();
    handlers.get("unhandledRejection")!("plain string reason");
    expect(error.mock.calls).toEqual([["[UNHANDLED REJECTION]", "plain string reason"]]);
  });

  it("index.ts keeps its own redaction", async () => {
    boot = await bootIndex({ callStart: false });
    boot.handlers.get("uncaughtException")![0](pgLikeError());
    assertRedacted(boot.logs.filter((l) => l.level === "error").map((l) => l.args), "[UNCAUGHT EXCEPTION]");
  });

  it("handlers stay registered so an uncaught error does not exit the process", async () => {
    const { handlers, exit } = await loadErrorsModule();
    expect(handlers.has("uncaughtException")).toBe(true);
    expect(handlers.has("unhandledRejection")).toBe(true);
    handlers.get("uncaughtException")!(pgLikeError());
    handlers.get("unhandledRejection")!(pgLikeError());
    expect(exit).not.toHaveBeenCalled();
  });
});
