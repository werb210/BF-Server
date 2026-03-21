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

describe("boot behavior", () => {
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

  it("starts without required env vars and serves boot endpoints", async () => {
    const originalEnv = process.env;
    process.env = {
      PORT: "0",
      STARTUP_WATCHDOG_MS: "2000",
      NODE_ENV: "test",
      JWT_SECRET: "test-access-secret",
      TWILIO_ACCOUNT_SID: "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      TWILIO_AUTH_TOKEN: "test-auth-token-1234567890",
      TWILIO_VERIFY_SERVICE_SID: "VA00000000000000000000000000000000",
    };
    let exitSpy: vi.SpyInstance | null = null;

    try {
      exitSpy = jest
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      vi.resetModules();
      await new Promise<void>((resolve, reject) => {
        vi.stubEnv(() => {
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

      const bootRes = await fetch(new URL("/__boot", baseUrl), {
        redirect: "manual",
      });
      expect(bootRes.status).toBe(200);
      const bootJson = await bootRes.json();
      expect(bootJson.pid).toBe(process.pid);
      expect(bootJson.port).toBe(address.port);
      expect(Array.isArray(bootJson.envKeys)).toBe(true);

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy?.mockRestore();
      process.env = originalEnv;
    }
  });
});
