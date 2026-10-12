// BF_SERVER_v784_PROCESS_HANDLERS - the process-level handlers src/index.ts registers,
// exercised by importing it with its dependencies stubbed and firing the handlers.
import { afterEach, describe, it, expect, vi } from "vitest";
import { bootIndex, type Boot } from "./helpers/bootIndex.js";

let boot: Boot | null = null;
afterEach(() => { boot?.restore(); boot = null; });

describe("src/index.ts process handlers", () => {
  it("registers each handler exactly once", async () => {
    boot = await bootIndex({ callStart: false });
    expect(boot.handlers.get("uncaughtException")).toHaveLength(1);
    expect(boot.handlers.get("unhandledRejection")).toHaveLength(1);
  });

  it("uncaughtException logs and exits 1", async () => {
    boot = await bootIndex({ callStart: false });
    boot.handlers.get("uncaughtException")![0](new Error("boom"));
    expect(boot.logText("error")).toContain("[UNCAUGHT EXCEPTION] boom");
    expect(boot.exitCodes).toEqual([1]);
  });

  it("unhandledRejection logs only and does not exit", async () => {
    boot = await bootIndex({ callStart: false });
    boot.handlers.get("unhandledRejection")![0](new Error("stray promise"));
    expect(boot.logText("error")).toContain("[UNHANDLED REJECTION] stray promise");
    expect(boot.exitCodes).toEqual([]);
  });

  it("a failed start() logs and exits 1", async () => {
    // Importing outside NODE_ENV=test runs start() itself; make it fail early.
    boot = await bootIndex({
      importNodeEnv: "development",
      stubs: { assertJwtSecretAtStartup: () => { throw new Error("JWT_SECRET is a placeholder"); } },
    });
    await vi.waitFor(() => expect(boot!.exitCodes).toEqual([1]));
    expect(boot.logText("error")).toContain("[STARTUP FAILED] JWT_SECRET is a placeholder");
    expect(boot.events).not.toContain("listen");
  });
});
