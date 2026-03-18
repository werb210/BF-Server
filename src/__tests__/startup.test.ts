import { resetStartupState } from "../startupState";
import { resolveBaseUrl } from "./helpers/baseUrl";

async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition_not_met");
}

describe("startup behavior", () => {
  let server: import("http").Server | null = null;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = null;
  });

  it("listens within 2s and responds to health before readiness", async () => {
    process.env.PORT = "0";
    process.env.STARTUP_WATCHDOG_MS = "2000";
    process.env.NODE_ENV = "test";
    resetStartupState();

    await new Promise<void>((resolve, reject) => {
      vi.isolateModules(() => {
        const { startServer } = require("../index");
        startServer()
          .then((listener: import("http").Server) => {
            server = listener;
            resolve();
          })
          .catch(reject);
      });
    });

    await waitForCondition(() => Boolean(server?.listening), 2000);

    const address = server?.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve server address.");
    }
    const baseUrl = resolveBaseUrl(server ?? undefined);
    const healthRes = await fetch(new URL("/health", baseUrl), {
      redirect: "manual",
    });
    expect(healthRes.status).toBe(200);

    const readyRes = await fetch(new URL("/api/_int/ready", baseUrl), {
      redirect: "manual",
    });
    expect(readyRes.status).toBe(503);
  });

  it("closes cleanly without hanging", async () => {
    process.env.PORT = "0";
    process.env.STARTUP_WATCHDOG_MS = "2000";
    process.env.NODE_ENV = "test";
    resetStartupState();

    await new Promise<void>((resolve, reject) => {
      vi.isolateModules(() => {
        const { startServer } = require("../index");
        startServer()
          .then((listener: import("http").Server) => {
            server = listener;
            resolve();
          })
          .catch(reject);
      });
    });

    await waitForCondition(() => Boolean(server?.listening), 2000);

    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    expect(server?.listening).toBe(false);
  });
});
