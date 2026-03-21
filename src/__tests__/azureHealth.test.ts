import { vi } from 'vitest';
import request from "supertest";
import { EventEmitter } from "events";
import { buildApp } from "../app";
import { markReady, resetStartupState } from "../startupState";

type MockServer = EventEmitter & {
  listening: boolean;
  close: (cb: () => void) => void;
};

function createMockServer(): MockServer {
  const server = new EventEmitter() as MockServer;
  server.listening = false;
  server.close = (cb: () => void) => cb();
  return server;
}

describe("azure health endpoints", () => {
  it("responds to health immediately", async () => {
    resetStartupState();
    const app = buildApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("gates readiness until the db is ready", async () => {
    resetStartupState();
    const app = buildApp();

    const before = await request(app).get("/api/_int/ready");
    expect(before.status).toBe(503);

    markReady();

    const after = await request(app).get("/api/_int/ready");
    expect(after.status).toBe(200);
  });

  it("respects the configured PORT env", async () => {
    process.env.PORT = "4777";
    process.env.STARTUP_WATCHDOG_MS = "25";

    const listenSpy = vi.fn((_port, _host, cb?: () => void) => {
      const server = createMockServer();
      server.listening = true;
      process.nextTick(() => {
        server.emit("listening");
        cb?.();
      });
      return server as unknown as import("http").Server;
    });

    await new Promise<void>((resolve, reject) => {
      vi.stubEnv(() => {
        vi.mock("../app", () => ({
          buildApp: () => ({ listen: listenSpy, use: vi.fn() }),
          registerApiRoutes: vi.fn(),
        }));
        const { startServer } = require("../index");
        startServer().then(() => resolve()).catch(reject);
      });
    });

    expect(listenSpy).toHaveBeenCalledWith(4777, "0.0.0.0", expect.any(Function));
  });
});
