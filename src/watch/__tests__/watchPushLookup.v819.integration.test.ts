// BF_SERVER_v819_PUSH - the Watch registration lookup selected p.id, a column watch_push_registrations does not
// have (its key is device_id). Every call threw "column p.id does not exist" against the real schema, while the
// mocked unit test passed. This runs the real query against the baseline schema.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../../db.js";
import { encryptWatchPushToken } from "../pushTokenCrypto.js";
import { WatchApnsError } from "../apnsProvider.js";
import { configureWatchPushProvider, sendWatchNotification } from "../notifications.js";

const staffUserId = randomUUID();
const deviceId = randomUUID();
const token = "a".repeat(64);
const input = { staffUserId, category: "MESSAGE" as const, eventType: "client_message" as const, title: "New client message", body: "New client message" };

describe("v819 Watch push lookup against the real schema", () => {
  beforeAll(async () => {
    await pool.query("INSERT INTO users (id, email, active) VALUES ($1, $2, true)", [staffUserId, `v819-${staffUserId}@example.test`]);
    await pool.query("INSERT INTO watch_devices (id, staff_user_id) VALUES ($1, $2)", [deviceId, staffUserId]);
    await pool.query(
      "INSERT INTO watch_push_registrations (device_id, token_hash, token_ciphertext, push_type, environment) VALUES ($1, 'h', $2, 'standard', 'production')",
      [deviceId, encryptWatchPushToken(token)],
    );
  });

  afterAll(async () => {
    configureWatchPushProvider(null);
    await pool.query("DELETE FROM watch_devices WHERE id = $1", [deviceId]).catch((e) => console.warn("cleanup", String(e)));
    await pool.query("DELETE FROM users WHERE id = $1", [staffUserId]).catch((e) => console.warn("cleanup", String(e)));
  });

  it("sends to the registered Watch token", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    configureWatchPushProvider({ send });
    await expect(sendWatchNotification(input)).resolves.toBe(1);
    expect(send).toHaveBeenCalledWith({ token, environment: "production" }, expect.objectContaining({ type: "client_message" }));
  });

  it("deletes a registration Apple reports as Unregistered", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    configureWatchPushProvider({ send: vi.fn().mockRejectedValue(new WatchApnsError(410, "Unregistered", true)) });
    await expect(sendWatchNotification(input)).resolves.toBe(0);
    const left = await pool.query("SELECT 1 FROM watch_push_registrations WHERE device_id = $1", [deviceId]);
    expect(left.rowCount).toBe(0);
  });
});
