import http2, { type ClientHttp2Session, type OutgoingHttpHeaders } from "node:http2";
import { createPrivateKey, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";
import type { WatchPushProvider } from "./notifications.js";

export type WatchApnsEnvironment = "sandbox" | "production";

export interface WatchApnsTransport {
  send(origin: string, headers: OutgoingHttpHeaders, payload: string): Promise<{ statusCode: number; body: string }>;
}

export type AppleWatchApnsConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
};

const HOSTS: Record<WatchApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};
const INVALID_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const SAFE_REASON = /^[A-Za-z][A-Za-z0-9]{0,79}$/;

export class WatchApnsError extends Error {
  readonly statusCode: number;
  readonly reason: string;
  readonly invalidRegistration: boolean;

  constructor(statusCode: number, reason: string, invalidRegistration = false) {
    super(`APNs request failed (${statusCode} ${reason})`);
    this.name = "WatchApnsError";
    this.statusCode = statusCode;
    this.reason = reason;
    this.invalidRegistration = invalidRegistration;
  }
}

/** A small reusable HTTP/2 transport. It contains no credentials and never logs requests. */
export class NodeWatchApnsTransport implements WatchApnsTransport {
  private readonly clients = new Map<string, ClientHttp2Session>();

  private client(origin: string): ClientHttp2Session {
    const existing = this.clients.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const created = http2.connect(origin);
    created.on("close", () => this.clients.delete(origin));
    // A session may emit an error without an active request listener.
    created.on("error", () => this.clients.delete(origin));
    this.clients.set(origin, created);
    return created;
  }

  send(origin: string, headers: OutgoingHttpHeaders, payload: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = this.client(origin).request(headers);
      let statusCode = 0;
      let body = "";
      request.setEncoding("utf8");
      request.on("response", (responseHeaders) => { statusCode = Number(responseHeaders[":status"] ?? 0); });
      request.on("data", (chunk: string) => { if (body.length < 4096) body += chunk; });
      request.on("end", () => resolve({ statusCode, body }));
      request.on("error", reject);
      request.end(payload);
    });
  }
}

export class AppleWatchApnsProvider implements WatchPushProvider {
  private readonly privateKey: KeyObject;
  private cachedToken: { value: string; issuedAtMs: number } | null = null;

  constructor(
    private readonly config: AppleWatchApnsConfig,
    private readonly transport: WatchApnsTransport = new NodeWatchApnsTransport(),
    private readonly now: () => number = Date.now,
    private readonly tokenLifetimeMs = 50 * 60 * 1000,
  ) {
    for (const [name, value] of Object.entries(config)) {
      if (!value.trim()) throw new Error(`Invalid APNs configuration: ${name}`);
    }
    if (!config.privateKey.includes("-----BEGIN PRIVATE KEY-----") || !config.privateKey.includes("-----END PRIVATE KEY-----")) {
      throw new Error("Invalid APNs private key format");
    }
    try {
      this.privateKey = createPrivateKey(config.privateKey);
      if (this.privateKey.asymmetricKeyType !== "ec") throw new Error("wrong key type");
    } catch {
      throw new Error("Invalid APNs private key");
    }
  }

  private providerToken(): string {
    const nowMs = this.now();
    if (this.cachedToken && nowMs - this.cachedToken.issuedAtMs < this.tokenLifetimeMs) return this.cachedToken.value;
    const issuedAt = Math.floor(nowMs / 1000);
    const value = jwt.sign({ iss: this.config.teamId, iat: issuedAt }, this.privateKey, {
      algorithm: "ES256",
      header: { alg: "ES256", kid: this.config.keyId },
    });
    this.cachedToken = { value, issuedAtMs: nowMs };
    return value;
  }

  async send(registration: { token: string; environment: WatchApnsEnvironment }, payload: Record<string, unknown>): Promise<void> {
    const response = await this.transport.send(HOSTS[registration.environment], {
      ":method": "POST",
      ":path": `/3/device/${registration.token}`,
      authorization: `bearer ${this.providerToken()}`,
      "apns-topic": this.config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "0",
      "content-type": "application/json",
    }, JSON.stringify(payload));
    if (response.statusCode === 200) return;

    let reason = "InvalidResponse";
    try {
      const parsed: unknown = JSON.parse(response.body);
      const candidate = (parsed as { reason?: unknown })?.reason;
      if (typeof candidate === "string" && SAFE_REASON.test(candidate)) reason = candidate;
    } catch { /* Apple returned no safe structured reason. */ }
    throw new WatchApnsError(response.statusCode, reason, INVALID_REASONS.has(reason));
  }
}
