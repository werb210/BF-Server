import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import { AppleWatchApnsProvider, WatchApnsError, type WatchApnsTransport } from "../apnsProvider.js";

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
