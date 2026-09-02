import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashWatchSecret } from "../security.js";
import { decryptWatchPushToken, encryptWatchPushToken } from "../pushTokenCrypto.js";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

describe("standalone Watch server contract", () => {
  it("mounts auth, device, data, and telephony surfaces without changing iPhone token", () => {
    const registry = read("src/routes/routeRegistry.ts");
    const telephony = read("src/telephony/routes/telephonyRoutes.ts");
    const voice = read("src/routes/voiceCalls.ts");
    expect(registry).toContain('{ path: "/watch", router: watchRoutes }');
    expect(telephony).toContain('router.use("/watch", watchCallRoutes)');
    expect(voice).toContain('router.post("/token", auth');
  });

  it("persists independently revocable credentials and authoritative bridge state", () => {
    const migration = read("migrations/2026_09_02_v154_watch_backend.sql");
    for (const table of ["watch_devices", "watch_sessions", "watch_push_registrations", "watch_call_bridges"])
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(migration).toContain("refresh_token_hash");
    expect(migration).toContain("revoked_at");
    expect(migration).toContain("UNIQUE(staff_user_id,idempotency_key)");
  });

  it("hashes secrets deterministically without retaining plaintext", () => {
    const secret = "do-not-store-this-watch-secret";
    const hash = hashWatchSecret(secret);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(secret);
    expect(hashWatchSecret(secret)).toBe(hash);
  });

  it("encrypts APNs tokens at rest and decrypts only for transport", () => {
    process.env.WATCH_PUSH_ENCRYPTION_KEY = "test-only-key";
    const token = "a".repeat(64);
    const ciphertext = encryptWatchPushToken(token);
    expect(ciphertext).not.toContain(token);
    expect(decryptWatchPushToken(ciphertext)).toBe(token);
  });

  it("keeps callback selection and connected state server controlled", () => {
    const calls = read("src/watch/callRoutes.ts");
    expect(calls).toContain('Object.prototype.hasOwnProperty.call(req.body || {}, "callbackNumber")');
    expect(calls).toContain('"in-progress": "connected"');
    expect(calls).not.toContain("req.body?.status");
  });

  it("enforces line grants rather than trusting the line query", () => {
    const security = read("src/watch/security.ts");
    const data = read("src/watch/dataRoutes.ts");
    expect(security).toContain("return granted.has(normalized)");
    expect(data).toContain("allowedLine(req, requested)");
    expect(data).toContain("Math.min(max");
  });

  it("allowlists minimal standard-APNs notification payload fields", () => {
    const notifications = read("src/watch/notifications.ts");
    expect(notifications).toContain('"MESSAGE", "TASK", "MEETING", "MISSED_CALL"');
    expect(notifications).toContain("Deliberately allowlist fields");
    for (const sensitive of ["bankBalance", "creditScore", "jwt", "apiCredential"])
      expect(notifications).not.toContain(sensitive);
  });
});
