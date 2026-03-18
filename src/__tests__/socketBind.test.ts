import { EventEmitter } from "events";

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

describe("socket bind", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("uses a single listener with the configured port", async () => {
    process.env.PORT = "4555";
    process.env.STARTUP_WATCHDOG_MS = "25";

    const listenSpy = jest.fn((_port, _host, cb?: () => void) => {
      const server = createMockServer();
      server.listening = true;
      process.nextTick(() => {
        server.emit("listening");
        cb?.();
      });
      return server as unknown as import("http").Server;
    });

    await new Promise<void>((resolve, reject) => {
      vi.isolateModules(() => {
        vi.mock("../app", () => ({
          buildApp: () => ({ listen: listenSpy, use: jest.fn() }),
          registerApiRoutes: jest.fn(),
        }));
        const { startServer } = require("../index");
        startServer().then(() => resolve()).catch(reject);
      });
    });

    expect(listenSpy).toHaveBeenCalledTimes(1);
    expect(listenSpy).toHaveBeenCalledWith(4555, "0.0.0.0", expect.any(Function));
  });

  it("binds to 0.0.0.0 on the env port", async () => {
    process.env.PORT = "4999";
    process.env.STARTUP_WATCHDOG_MS = "25";

    const listenSpy = jest.fn((_port, _host, cb?: () => void) => {
      const server = createMockServer();
      server.listening = true;
      process.nextTick(() => {
        server.emit("listening");
        cb?.();
      });
      return server as unknown as import("http").Server;
    });

    await new Promise<void>((resolve, reject) => {
      vi.isolateModules(() => {
        vi.mock("../app", () => ({
          buildApp: () => ({ listen: listenSpy, use: jest.fn() }),
          registerApiRoutes: jest.fn(),
        }));
        const { startServer } = require("../index");
        startServer().then(() => resolve()).catch(reject);
      });
    });

    expect(listenSpy).toHaveBeenCalledWith(4999, "0.0.0.0", expect.any(Function));
  });
});
