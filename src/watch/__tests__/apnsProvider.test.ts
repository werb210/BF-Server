import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppleWatchApnsProvider,
  NodeWatchApnsTransport,
  WatchApnsError,
  WatchApnsTimeoutError,
  type WatchApnsTransport,
} from "../apnsProvider.js";

const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const config = { teamId: "TEAM123", keyId: "KEY123", privateKey, bundleId: "example.watchkitapp" };

function fake(statusCode = 200, body = ""): WatchApnsTransport & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue({ statusCode, body }) };
}

describe("AppleWatchApnsProvider", () => {
  it("uses a cached ES256 Apple token with the required claims and headers", async () => {
    const transport = fake();
    let now = 1_800_000_000_000;
    const provider = new AppleWatchApnsProvider(config, transport, () => now);
    await provider.send({ token: "token-one", environment: "sandbox" }, { schema: 1 });
    await provider.send({ token: "token-two", environment: "production" }, { schema: 1 });
    const firstHeaders = transport.send.mock.calls[0][1];
    const secondHeaders = transport.send.mock.calls[1][1];
    expect(firstHeaders.authorization).toBe(secondHeaders.authorization);
    const token = String(firstHeaders.authorization).slice("bearer ".length);
    expect(jwt.decode(token, { complete: true })).toMatchObject({
      header: { alg: "ES256", kid: "KEY123" }, payload: { iss: "TEAM123", iat: 1_800_000_000 },
    });
    expect(String(firstHeaders.authorization)).not.toContain(privateKey);

    now += 50 * 60 * 1000;
    await provider.send({ token: "token-three", environment: "sandbox" }, { schema: 1 });
    expect(transport.send.mock.calls[2][1].authorization).not.toBe(firstHeaders.authorization);
  });

  it("selects the registration host and sends standard-alert headers and exact token path", async () => {
    const transport = fake();
    const provider = new AppleWatchApnsProvider(config, transport);
    await provider.send({ token: "ABC-unchanged", environment: "sandbox" }, { schema: 1 });
    await provider.send({ token: "XYZ", environment: "production" }, { schema: 1 });
    expect(transport.send.mock.calls[0][0]).toBe("https://api.sandbox.push.apple.com");
    expect(transport.send.mock.calls[1][0]).toBe("https://api.push.apple.com");
    expect(transport.send.mock.calls[0][1]).toMatchObject({
      ":method": "POST", ":path": "/3/device/ABC-unchanged", "apns-topic": "example.watchkitapp",
      "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": "0", "content-type": "application/json",
    });
  });

  it.each(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"])("marks %s terminal", async (reason) => {
    const provider = new AppleWatchApnsProvider(config, fake(400, JSON.stringify({ reason })));
    await expect(provider.send({ token: "x", environment: "production" }, {})).rejects.toMatchObject({
      statusCode: 400, reason, invalidRegistration: true,
    });
  });

  it.each([429, 500])("keeps HTTP %s retryable", async (statusCode) => {
    const provider = new AppleWatchApnsProvider(config, fake(statusCode, '{"reason":"TooManyRequests"}'));
    await expect(provider.send({ token: "x", environment: "production" }, {})).rejects.toMatchObject({ invalidRegistration: false });
  });

  it("turns malformed failures into a safe typed error", async () => {
    const provider = new AppleWatchApnsProvider(config, fake(503, privateKey));
    const error = await provider.send({ token: "secret-token", environment: "production" }, {}).catch((e) => e);
    expect(error).toBeInstanceOf(WatchApnsError);
    expect(error).toMatchObject({ statusCode: 503, reason: "InvalidResponse", invalidRegistration: false });
    expect(String(error)).not.toContain("secret-token");
    expect(String(error)).not.toContain(privateKey);
  });
});

class FakeRequest extends EventEmitter {
  readonly close = vi.fn();
  readonly end = vi.fn();
  readonly setEncoding = vi.fn();
}

class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  readonly request = vi.fn(() => new FakeRequest());
}

describe("NodeWatchApnsTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a request that ends before its timeout and cleans up", async () => {
    vi.useFakeTimers();
    const session = new FakeSession();
    const transport = new NodeWatchApnsTransport(100, vi.fn(() => session as any));
    const promise = transport.send("https://apns.example", {}, "payload");
    const request = session.request.mock.results[0].value;

    request.emit("response", { ":status": 200 });
    request.emit("data", "ok");
    request.emit("end");

    await expect(promise).resolves.toEqual({ statusCode: 200, body: "ok" });
    expect(vi.getTimerCount()).toBe(0);
    expect(request.listenerCount("end")).toBe(0);
    expect(request.listenerCount("error")).toBe(0);
    request.emit("end");
  });

  it("times out once, cancels only the request, and does not expose credentials", async () => {
    vi.useFakeTimers();
    const session = new FakeSession();
    const connect = vi.fn(() => session as any);
    const transport = new NodeWatchApnsTransport(100, connect);
    const secrets = {
      token: "device-token-secret",
      key: "private-key-secret",
      jwt: "provider-jwt-secret",
    };
    const promise = transport.send("https://apns.example", {
      ":path": `/3/device/${secrets.token}`,
      authorization: `bearer ${secrets.jwt}`,
    }, secrets.key);
    const rejection = vi.fn();
    void promise.catch(rejection);

    await vi.advanceTimersByTimeAsync(100);
    const error = await promise.catch((failure: unknown) => failure);
    const request = session.request.mock.results[0].value;

    expect(error).toBeInstanceOf(WatchApnsTimeoutError);
    expect(error).toMatchObject({ invalidRegistration: false });
    expect(String(error)).not.toContain(secrets.token);
    expect(String(error)).not.toContain(secrets.key);
    expect(String(error)).not.toContain(secrets.jwt);
    expect(rejection).toHaveBeenCalledTimes(1);
    expect(request.close).toHaveBeenCalledTimes(1);
    expect(session.listenerCount("close")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(request.listenerCount("end")).toBe(0);
    expect(request.listenerCount("error")).toBe(0);
    request.emit("end");
    expect(rejection).toHaveBeenCalledTimes(1);
  });

  it("rejects once on a request error before timeout and clears the timer", async () => {
    vi.useFakeTimers();
    const session = new FakeSession();
    const transport = new NodeWatchApnsTransport(100, vi.fn(() => session as any));
    const promise = transport.send("https://apns.example", {}, "payload");
    const rejection = vi.fn();
    void promise.catch(rejection);
    const request = session.request.mock.results[0].value;

    request.emit("error", new Error("network failure"));
    await expect(promise).rejects.toThrow("network failure");
    await vi.advanceTimersByTimeAsync(100);

    expect(rejection).toHaveBeenCalledTimes(1);
    expect(request.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses a healthy session after a failed request and recreates one after session failure", async () => {
    vi.useFakeTimers();
    const firstSession = new FakeSession();
    const secondSession = new FakeSession();
    const connect = vi.fn()
      .mockReturnValueOnce(firstSession as any)
      .mockReturnValueOnce(secondSession as any);
    const transport = new NodeWatchApnsTransport(100, connect);

    const failed = transport.send("https://apns.example", {}, "one");
    firstSession.request.mock.results[0].value.emit("error", new Error("request failed"));
    await expect(failed).rejects.toThrow("request failed");

    const reused = transport.send("https://apns.example", {}, "two");
    expect(connect).toHaveBeenCalledTimes(1);
    firstSession.request.mock.results[1].value.emit("end");
    await expect(reused).resolves.toEqual({ statusCode: 0, body: "" });

    firstSession.emit("error", new Error("session failed"));
    const recreated = transport.send("https://apns.example", {}, "three");
    expect(connect).toHaveBeenCalledTimes(2);
    secondSession.request.mock.results[0].value.emit("end");
    await expect(recreated).resolves.toEqual({ statusCode: 0, body: "" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
