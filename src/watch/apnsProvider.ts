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

export class WatchApnsTimeoutError extends Error {
  readonly invalidRegistration = false;

  constructor(timeoutMs: number) {
    super(`APNs request timed out after ${timeoutMs}ms`);
    this.name = "WatchApnsTimeoutError";
  }
}

// BF_SERVER_v819_PUSH - the stream closed (session torn down underneath it) before Apple answered.
export class WatchApnsConnectionError extends Error {
  readonly invalidRegistration = false;

  constructor(reason: string) {
    super(`APNs connection lost before a response (${reason})`);
    this.name = "WatchApnsConnectionError";
  }
}

// BF_SERVER_v819_PUSH - every client push and Watch push hung for 10 s and timed out in production
// (client_apns_send_failed "APNs request timed out after 10000ms", one api.push.apple.com socket held
// open for hours). The cached HTTP/2 session went stale - the idle connection was silently dropped by
// Azure/NAT/Apple - but nothing ever closed it, so every later request was written into a dead socket.
// Sessions now close after an idle period, are dropped on goaway/error/close/timeout/ERR_HTTP2_*, and a
// send that fails at the transport level is retried ONCE on a fresh session. An HTTP status from Apple
// is an answer, never a transport failure, and is never retried here.
const DEFAULT_IDLE_TIMEOUT_MS = 50_000;
const RETRYABLE_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "ENETUNREACH", "EHOSTUNREACH"]);

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

/** True when a failure came from the connection rather than from Apple's answer. */
export function isApnsTransportFailure(error: unknown): boolean {
  if (error instanceof WatchApnsTimeoutError || error instanceof WatchApnsConnectionError) return true;
  const code = errorCode(error);
  return code.startsWith("ERR_HTTP2_") || RETRYABLE_SOCKET_CODES.has(code);
}

/** A small reusable HTTP/2 transport. It contains no credentials and never logs requests. */
export class NodeWatchApnsTransport implements WatchApnsTransport {
  private readonly clients = new Map<string, ClientHttp2Session>();

  constructor(
    private readonly requestTimeoutMs = 10_000,
    private readonly connect: typeof http2.connect = http2.connect,
    private readonly idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  ) {}

  /** Forget a session (so the next send connects afresh) and optionally tear it down. */
  private discard(origin: string, session: ClientHttp2Session, reason: string, destroy: boolean): void {
    const wasCached = this.clients.get(origin) === session;
    if (wasCached) this.clients.delete(origin);
    if (destroy && !session.destroyed && typeof session.destroy === "function") {
      try { session.destroy(); } catch { /* already torn down */ }
    }
    if (wasCached) console.warn(JSON.stringify({ event: "apns_session_reset", host: origin.replace(/^https:\/\//, ""), reason }));
  }

  private client(origin: string): ClientHttp2Session {
    const existing = this.clients.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    if (existing) this.clients.delete(origin);
    const created = this.connect(origin);
    this.clients.set(origin, created);
    // BF_SERVER_v819_PUSH - the cached session must never outlive its connection.
    created.on("close", () => this.discard(origin, created, "close", false));
    // A session may emit an error without an active request listener; the listener also keeps it from crashing the process.
    created.on("error", (error: unknown) => this.discard(origin, created, `error:${errorCode(error) || "unknown"}`, true));
    // Apple sends GOAWAY when it retires a connection; in-flight streams may finish, new ones need a new session.
    created.on("goaway", () => {
      this.discard(origin, created, "goaway", false);
      if (!created.closed && !created.destroyed && typeof created.close === "function") {
        try { created.close(); } catch { /* already closing */ }
      }
    });
    // An idle connection is what NAT/load balancers drop silently. Close it ourselves before that happens.
    if (typeof created.setTimeout === "function") created.setTimeout(this.idleTimeoutMs);
    created.on("timeout", () => this.discard(origin, created, "idle", true));
    // The push socket must never keep the process alive on shutdown.
    if (typeof created.unref === "function") created.unref();
    return created;
  }

  async send(origin: string, headers: OutgoingHttpHeaders, payload: string): Promise<{ statusCode: number; body: string }> {
    try {
      return await this.attempt(origin, headers, payload);
    } catch (error) {
      // BF_SERVER_v819_PUSH - the failed session has been discarded; one retry runs on a fresh connection.
      if (!isApnsTransportFailure(error)) throw error;
      return this.attempt(origin, headers, payload);
    }
  }

  private attempt(origin: string, headers: OutgoingHttpHeaders, payload: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      let session: ClientHttp2Session;
      let request: ReturnType<ClientHttp2Session["request"]>;
      try {
        session = this.client(origin);
        request = session.request(headers);
      } catch (error) {
        // request() throws synchronously on a session that is closing/destroyed (ERR_HTTP2_*).
        const failed = this.clients.get(origin);
        if (failed) this.discard(origin, failed, `request:${errorCode(error) || "unknown"}`, true);
        reject(error);
        return;
      }
      let statusCode = 0;
      let body = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(timer);
        request.off("response", onResponse);
        request.off("data", onData);
        request.off("end", onEnd);
        request.off("error", onError);
        request.off("close", onClose);
      };
      const settle = (result: { statusCode: number; body: string } | Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const onResponse = (responseHeaders: OutgoingHttpHeaders) => {
        statusCode = Number(responseHeaders[":status"] ?? 0);
      };
      const onData = (chunk: string) => { if (body.length < 4096) body += chunk; };
      const onEnd = () => {
        // BF_SERVER_v819_PUSH - a stream "ends" without any response when its session is destroyed; that is a
        // lost connection, not an answer from Apple.
        if (!statusCode && (session.destroyed || session.closed)) settle(new WatchApnsConnectionError("session_closed"));
        else settle({ statusCode, body });
      };
      const onClose = () => settle(statusCode ? { statusCode, body } : new WatchApnsConnectionError("stream_closed"));
      const onError = (error: Error) => {
        if (isApnsTransportFailure(error)) this.discard(origin, session, `stream:${errorCode(error)}`, true);
        settle(error);
      };

      request.setEncoding("utf8");
      request.on("response", onResponse);
      request.on("data", onData);
      request.on("end", onEnd);
      request.on("error", onError);
      request.on("close", onClose);
      timer = setTimeout(() => {
        settle(new WatchApnsTimeoutError(this.requestTimeoutMs));
        request.close(http2.constants.NGHTTP2_CANCEL);
        // BF_SERVER_v819_PUSH - a request that gets no answer means the connection is dead, not slow.
        this.discard(origin, session, "request_timeout", true);
      }, this.requestTimeoutMs);
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
