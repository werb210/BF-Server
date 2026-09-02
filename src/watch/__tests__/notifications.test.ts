import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

import { WatchApnsError } from "../apnsProvider.js";
import { configureWatchPushProvider, sendWatchNotification } from "../notifications.js";

const input = { staffUserId: "staff-1", category: "MESSAGE" as const, eventType: "client_message" as const,
  title: "T".repeat(80), body: "B".repeat(140), resourceId: "opaque-id" };
const deps = () => ({ query: query as any, decrypt: (value: string) => `plain:${value}` });

beforeEach(() => { query.mockReset(); configureWatchPushProvider(null); });

describe("sendWatchNotification", () => {
  it("returns zero without querying when no provider is configured", async () => {
    expect(await sendWatchNotification(input, deps())).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("sends the exact version-one allowlisted contract to mixed environments", async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: "r1", device_id: "d1", token_ciphertext: "cipher1", environment: "sandbox" },
      { id: "r2", device_id: "d2", token_ciphertext: "cipher2", environment: "production" },
    ] });
    const send = vi.fn().mockResolvedValue(undefined);
    configureWatchPushProvider({ send });
    expect(await sendWatchNotification(input, deps())).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toEqual({ token: "plain:cipher1", environment: "sandbox" });
    expect(send.mock.calls[1][0].environment).toBe("production");
    expect(send.mock.calls[0][1]).toEqual({
      aps: { alert: { title: "T".repeat(60), body: "B".repeat(120) }, sound: "default", category: "MESSAGE" },
      schema: 1, type: "client_message", id: "opaque-id",
    });
    expect(send.mock.calls[0][1]).not.toHaveProperty("eventType");
    expect(send.mock.calls[0][1]).not.toHaveProperty("resourceId");
  });

  it("deletes only a terminal registration and continues to a valid registration", async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: "bad", token_ciphertext: "bad-cipher", environment: "sandbox" },
      { id: "good", token_ciphertext: "good-cipher", environment: "production" },
    ] }).mockResolvedValueOnce({ rows: [] });
    const send = vi.fn()
      .mockRejectedValueOnce(new WatchApnsError(410, "Unregistered", true))
      .mockResolvedValueOnce(undefined);
    configureWatchPushProvider({ send });
    expect(await sendWatchNotification(input, deps())).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(2, "DELETE FROM watch_push_registrations WHERE id=$1", ["bad"]);
  });

  it("does not delete a transient provider failure", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "r1", token_ciphertext: "cipher", environment: "production" }] });
    configureWatchPushProvider({ send: vi.fn().mockRejectedValue(new WatchApnsError(500, "InternalServerError")) });
    expect(await sendWatchNotification(input, deps())).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("queries only active devices with standard registrations", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    configureWatchPushProvider({ send: vi.fn() });
    await sendWatchNotification(input, deps());
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("d.revoked_at IS NULL");
    expect(sql).toContain("p.push_type='standard'");
  });

  it("cannot pass arbitrary sensitive data through the opaque id field", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "r1", token_ciphertext: "cipher", environment: "production" }] });
    const send = vi.fn().mockResolvedValue(undefined);
    configureWatchPushProvider({ send });
    await sendWatchNotification({ ...input, resourceId: "account balance: $12,345" }, deps());
    expect(send.mock.calls[0][1]).not.toHaveProperty("id");
  });
});
