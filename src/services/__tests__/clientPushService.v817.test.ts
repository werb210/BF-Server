// BF_SERVER_v817_CLIENT - client app on its own Apple team: own APNs credentials, host fallback, logged failures.
import { describe, expect, it, vi, beforeEach } from "vitest";

import { pool } from "../../db.js";
import { WatchApnsError } from "../../watch/apnsProvider.js";
import { __setClientPushProvider, clientApnsCredentials, sendClientPush } from "../clientPushService.js";
import { pushConfigReport } from "../../modules/diagnostics/pushConfig.js";

describe("BF_SERVER_v817_CLIENT client APNs", () => {
  let deleted: string[];
  beforeEach(() => {
    deleted = [];
    __setClientPushProvider(null);
    vi.spyOn(pool, "query").mockImplementation((async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT token")) return { rows: [{ token: "ios-token", platform: "ios" }] };
      if (sql.includes("DELETE FROM client_push_tokens")) deleted.push(String(params?.[0]));
      return { rows: [] };
    }) as typeof pool.query);
  });

  it("prefers CLIENT_APNS_* credentials and falls back to WATCH_APNS_*", () => {
    const env = {
      WATCH_APNS_TEAM_ID: "OLDTEAM", WATCH_APNS_KEY_ID: "OLDKEY", WATCH_APNS_PRIVATE_KEY: "old\\nkey",
      CLIENT_APNS_TEAM_ID: "76VAY7UJKJ", CLIENT_APNS_KEY_ID: "9B33SK95MP",
      CLIENT_APNS_BUNDLE_ID_BF: "com.borealfinancial.client",
    } as NodeJS.ProcessEnv;
    expect(clientApnsCredentials(env)).toEqual({
      teamId: "76VAY7UJKJ", keyId: "9B33SK95MP", privateKey: "old\nkey", bundleId: "com.borealfinancial.client",
    });
  });

  it("counts the client override as configured in the diagnostics", () => {
    const report = pushConfigReport({
      CLIENT_APNS_TEAM_ID: "76VAY7UJKJ", CLIENT_APNS_KEY_ID: "9B33SK95MP", CLIENT_APNS_PRIVATE_KEY: "k",
      CLIENT_APNS_BUNDLE_ID_BF: "com.borealfinancial.client",
    });
    expect(report.transports.find((t) => t.transport === "client_apns")?.configured).toBe(true);
    expect(report.transports.find((t) => t.transport === "watch_apns")?.configured).toBe(false);
  });

  it("retries a BadDeviceToken on the other APNs host before dropping the token", async () => {
    const send = vi.fn(async (reg: { environment: string }) => {
      if (reg.environment === "production") throw new WatchApnsError(400, "BadDeviceToken", true);
    });
    __setClientPushProvider({ send } as never);
    const result = await sendClientPush({ userId: "client:+15875550100", title: "t", body: "b" });
    expect(result.sent).toBe(1);
    expect(send.mock.calls.map((c) => (c[0] as { environment: string }).environment)).toEqual(["production", "sandbox"]);
    expect(deleted).toEqual([]);
  });

  it("logs why Apple refused a push instead of failing silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async () => { throw new WatchApnsError(403, "InvalidProviderToken"); });
    __setClientPushProvider({ send } as never);
    const result = await sendClientPush({ userId: "client:+15875550100", title: "t", body: "b" });
    expect(result).toEqual({ sent: 0, skipped: 1, unsupported: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("InvalidProviderToken");
    expect(deleted).toEqual([]);
  });
});
