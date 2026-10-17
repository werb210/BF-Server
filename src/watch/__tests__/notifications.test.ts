import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js"; // BF_SERVER_SQL_CONTENT_MOCKS_v762

const query = vi.fn();

import { WatchApnsError, WatchApnsTimeoutError } from "../apnsProvider.js";
import { configureWatchPushProvider, sendWatchNotification } from "../notifications.js";

const input = { staffUserId: "staff-1", category: "MESSAGE" as const, eventType: "client_message" as const,
  title: "T".repeat(80), body: "B".repeat(140), resourceId: "opaque-id" };
// BF_SERVER_v789_SQL_CONTENT_MOCKS - the registration lookup is answered by SQL text, not by call order.
const REGS = /FROM watch_push_registrations p/;
const answerRegs = (rows: unknown[]) => query.mockImplementation(answerBySql([[REGS, { rows }]]));
const deps = () => ({ query: query as any, decrypt: (value: string) => `plain:${value}` });

beforeEach(() => { query.mockReset(); configureWatchPushProvider(null); });

describe("sendWatchNotification", () => {
  it("returns zero without querying when no provider is configured", async () => {
    expect(await sendWatchNotification(input, deps())).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("sends the exact version-one allowlisted contract to mixed environments", async () => {
    answerRegs([
      { id: "r1", device_id: "d1", token_ciphertext: "cipher1", environment: "sandbox" },
      { id: "r2", device_id: "d2", token_ciphertext: "cipher2", environment: "production" },
    ]);
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

  it.each(["BadDeviceToken", "Unregistered"])("deletes a %s registration and continues to a valid registration", async (reason) => {
    query.mockImplementation(answerBySql([
      [REGS, { rows: [
        { id: "bad", token_ciphertext: "bad-cipher", environment: "sandbox" },
        { id: "good", token_ciphertext: "good-cipher", environment: "production" },
      ] }],
      [/DELETE FROM watch_push_registrations/, { rows: [] }],
    ]));
    // BF_SERVER_v819_PUSH - a BadDeviceToken is first retried on the other host, so the bad token fails on both.
    const send = vi.fn(async (registration: { token: string }) => {
      if (registration.token === "plain:bad-cipher") throw new WatchApnsError(410, reason, true);
    });
    configureWatchPushProvider({ send });
    expect(await sendWatchNotification(input, deps())).toBe(1);
    expect(send).toHaveBeenCalledTimes(reason === "BadDeviceToken" ? 3 : 2);
    expect(query).toHaveBeenCalledWith("DELETE FROM watch_push_registrations WHERE device_id=$1" /* BF_SERVER_v819_PUSH - no id column */, ["bad"]);
  });

  it.each([
    ["timeout", new WatchApnsTimeoutError(10_000)],
    ["HTTP 429", new WatchApnsError(429, "TooManyRequests")],
    ["HTTP 500", new WatchApnsError(500, "InternalServerError")],
  ])("does not delete a transient %s failure", async (_label, failure) => {
    answerRegs([{ id: "r1", token_ciphertext: "cipher", environment: "production" }]);
    configureWatchPushProvider({ send: vi.fn().mockRejectedValue(failure) });
    expect(await sendWatchNotification(input, deps())).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("queries only active devices with standard registrations", async () => {
    answerRegs([]);
    configureWatchPushProvider({ send: vi.fn() });
    await sendWatchNotification(input, deps());
    const lookups = callsMatching(query, REGS);
    expect(lookups).toHaveLength(1);
    const sql = lookups[0][0] as string;
    expect(sql).toContain("d.revoked_at IS NULL");
    expect(sql).toContain("p.push_type='standard'");
  });

  // BF_SERVER_v819_PUSH - a sandbox token registered as production (or the reverse) is delivered, not deleted.
  it("retries BadDeviceToken on the other APNs host and remembers the host that worked", async () => {
    query.mockImplementation(answerBySql([[REGS, { rows: [{ id: "d1", device_id: "d1", token_ciphertext: "c", environment: "production" }] }]]));
    const send = vi.fn(async (registration: { environment: string }) => {
      if (registration.environment === "production") throw new WatchApnsError(400, "BadDeviceToken", true);
    });
    configureWatchPushProvider({ send });
    expect(await sendWatchNotification(input, deps())).toBe(1);
    expect(send.mock.calls.map(([r]) => (r as { environment: string }).environment)).toEqual(["production", "sandbox"]);
    expect(callsMatching(query, /DELETE FROM watch_push_registrations/)).toHaveLength(0);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE watch_push_registrations SET environment=$2"), ["d1", "sandbox"]);
  });

  // BF_SERVER_v819_PUSH - the lookup must only name columns that exist on watch_push_registrations.
  it("selects only columns that exist on watch_push_registrations", async () => {
    answerRegs([]);
    configureWatchPushProvider({ send: vi.fn() });
    await sendWatchNotification(input, deps());
    const sql = callsMatching(query, REGS)[0][0] as string;
    const columns = ["device_id", "token_hash", "token_ciphertext", "push_type", "environment", "created_at", "updated_at"];
    for (const [, column] of sql.matchAll(/\bp\.([a-z_]+)/g)) expect(columns).toContain(column);
  });

  it("cannot pass arbitrary sensitive data through the opaque id field", async () => {
    answerRegs([{ id: "r1", token_ciphertext: "cipher", environment: "production" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    configureWatchPushProvider({ send });
    await sendWatchNotification({ ...input, resourceId: "account balance: $12,345" }, deps());
    expect(send.mock.calls[0][1]).not.toHaveProperty("id");
  });
});
