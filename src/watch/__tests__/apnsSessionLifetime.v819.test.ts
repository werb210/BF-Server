// BF_SERVER_v819_PUSH - the cached APNs HTTP/2 session went stale in production and every push hung until
// the 10 s timeout. These tests pin the session lifetime: idle close, goaway, timeout -> fresh session retry.
import http2 from "node:http2";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NodeWatchApnsTransport,
  WatchApnsConnectionError,
  WatchApnsTimeoutError,
  isApnsTransportFailure,
} from "../apnsProvider.js";

class FakeRequest extends EventEmitter {
  readonly close = vi.fn();
  readonly end = vi.fn();
  readonly setEncoding = vi.fn();
}

class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  readonly request = vi.fn(() => new FakeRequest());
  readonly setTimeout = vi.fn();
  readonly unref = vi.fn();
  readonly close = vi.fn(() => { this.closed = true; });
  readonly destroy = vi.fn(() => { this.destroyed = true; });
}

const ORIGIN = "https://api.push.apple.com";
const lastRequest = (session: FakeSession): FakeRequest =>
  session.request.mock.results[session.request.mock.results.length - 1].value;
const answer = (request: FakeRequest, status = 200, body = "") => {
  request.emit("response", { ":status": status });
  if (body) request.emit("data", body);
  request.emit("end");
};

describe("BF_SERVER_v819_PUSH NodeWatchApnsTransport session lifetime", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("unrefs every session and arms an idle timeout on it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new FakeSession();
    const transport = new NodeWatchApnsTransport(100, vi.fn(() => session as any), 50_000);
    void transport.send(ORIGIN, {}, "x").catch(() => {});
    expect(session.unref).toHaveBeenCalledTimes(1);
    expect(session.setTimeout).toHaveBeenCalledWith(50_000);
  });

  it("retries a hung request once on a fresh session and succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stale = new FakeSession();
    const fresh = new FakeSession();
    const connect = vi.fn().mockReturnValueOnce(stale as any).mockReturnValueOnce(fresh as any);
    const transport = new NodeWatchApnsTransport(10_000, connect);

    const promise = transport.send(ORIGIN, {}, "payload");
    await vi.advanceTimersByTimeAsync(10_000); // the stale session never answers
    expect(stale.destroy).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    answer(lastRequest(fresh), 200);
    await expect(promise).resolves.toEqual({ statusCode: 200, body: "" });

    // The fresh session is the cached one from now on.
    const next = transport.send(ORIGIN, {}, "again");
    expect(connect).toHaveBeenCalledTimes(2);
    answer(lastRequest(fresh), 200);
    await expect(next).resolves.toEqual({ statusCode: 200, body: "" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes an idle session and connects afresh for the next send", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const idle = new FakeSession();
    const fresh = new FakeSession();
    const connect = vi.fn().mockReturnValueOnce(idle as any).mockReturnValueOnce(fresh as any);
    const transport = new NodeWatchApnsTransport(1_000, connect);

    const first = transport.send(ORIGIN, {}, "one");
    answer(lastRequest(idle), 200);
    await first;

    idle.emit("timeout"); // http2 session.setTimeout fired: no traffic for the idle period
    expect(idle.destroy).toHaveBeenCalledTimes(1);

    const second = transport.send(ORIGIN, {}, "two");
    expect(connect).toHaveBeenCalledTimes(2);
    answer(lastRequest(fresh), 200);
    await expect(second).resolves.toEqual({ statusCode: 200, body: "" });
  });

  it("stops using a session after GOAWAY and closes it gracefully", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const retiring = new FakeSession();
    const fresh = new FakeSession();
    const connect = vi.fn().mockReturnValueOnce(retiring as any).mockReturnValueOnce(fresh as any);
    const transport = new NodeWatchApnsTransport(1_000, connect);

    const first = transport.send(ORIGIN, {}, "one");
    answer(lastRequest(retiring), 200);
    await first;

    retiring.emit("goaway", 0);
    expect(retiring.close).toHaveBeenCalledTimes(1);
    expect(retiring.destroy).not.toHaveBeenCalled();

    const second = transport.send(ORIGIN, {}, "two");
    expect(connect).toHaveBeenCalledTimes(2);
    answer(lastRequest(fresh), 200);
    await expect(second).resolves.toEqual({ statusCode: 200, body: "" });
  });

  it("retries once on an ERR_HTTP2_* stream error but not on a second one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = new FakeSession();
    const b = new FakeSession();
    const connect = vi.fn().mockReturnValueOnce(a as any).mockReturnValueOnce(b as any);
    const transport = new NodeWatchApnsTransport(1_000, connect);
    const streamError = () => Object.assign(new Error("stream reset"), { code: "ERR_HTTP2_STREAM_ERROR" });

    const promise = transport.send(ORIGIN, {}, "x");
    lastRequest(a).emit("error", streamError());
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    lastRequest(b).emit("error", streamError());
    await expect(promise).rejects.toMatchObject({ code: "ERR_HTTP2_STREAM_ERROR" });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("retries when request() throws synchronously on a session that is going away", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const closing = new FakeSession();
    closing.request.mockImplementation(() => {
      throw Object.assign(new Error("session closing"), { code: "ERR_HTTP2_GOAWAY_SESSION" });
    });
    const fresh = new FakeSession();
    const connect = vi.fn().mockReturnValueOnce(closing as any).mockReturnValueOnce(fresh as any);
    const transport = new NodeWatchApnsTransport(1_000, connect);

    const promise = transport.send(ORIGIN, {}, "x");
    await vi.waitFor(() => expect(fresh.request).toHaveBeenCalledTimes(1));
    answer(lastRequest(fresh), 200);
    await expect(promise).resolves.toEqual({ statusCode: 200, body: "" });
    expect(closing.destroy).toHaveBeenCalledTimes(1);
  });

  it("never retries an HTTP answer from Apple", async () => {
    const session = new FakeSession();
    const connect = vi.fn(() => session as any);
    const transport = new NodeWatchApnsTransport(1_000, connect);
    const promise = transport.send(ORIGIN, {}, "x");
    answer(lastRequest(session), 400, '{"reason":"BadDeviceToken"}');
    await expect(promise).resolves.toEqual({ statusCode: 400, body: '{"reason":"BadDeviceToken"}' });
    expect(session.request).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("classifies transport failures", () => {
    expect(isApnsTransportFailure(new WatchApnsTimeoutError(10))).toBe(true);
    expect(isApnsTransportFailure(new WatchApnsConnectionError("x"))).toBe(true);
    expect(isApnsTransportFailure(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isApnsTransportFailure(new Error("plain"))).toBe(false);
  });

  it("over a real HTTP/2 socket: a hung stream is retried on a new connection, and idle sessions close", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let streams = 0;
    const server = http2.createServer();
    server.on("stream", (stream) => {
      streams += 1;
      if (streams === 1) return; // never answer the first request, like a dead connection
      stream.respond({ ":status": 200 });
      stream.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const connect = vi.fn(((authority: string) => http2.connect(authority)) as typeof http2.connect);
    const transport = new NodeWatchApnsTransport(200, connect, 300);
    try {
      await expect(transport.send(origin, { ":method": "POST", ":path": "/3/device/x" }, "{}"))
        .resolves.toEqual({ statusCode: 200, body: "ok" });
      expect(connect).toHaveBeenCalledTimes(2);
      await new Promise((resolve) => setTimeout(resolve, 500)); // past the idle timeout
      await expect(transport.send(origin, { ":method": "POST", ":path": "/3/device/x" }, "{}"))
        .resolves.toEqual({ statusCode: 200, body: "ok" });
      expect(connect).toHaveBeenCalledTimes(3);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
