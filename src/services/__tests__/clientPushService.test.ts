// BF_SERVER_BLOCK_v334_CLIENT_PUSH_DELIVERY_v1
import { describe, expect, it, vi, beforeEach } from "vitest";

import { pool } from "../../db.js";

import { __setClientPushProvider, sendClientPush, isClientPushConfigured } from "../clientPushService.js";

describe("client push delivery", () => {
  beforeEach(() => {
    __setClientPushProvider(null);
    vi.spyOn(pool, "query").mockImplementation((async (sql: string) => {
      if (sql.includes("SELECT token")) {
        return { rows: [{ token: "ios-token", platform: "ios" }, { token: "fcm-token", platform: "android" }] };
      }
      return { rows: [] };
    }) as typeof pool.query);
  });

  it("is inert until APNs credentials exist", async () => {
    expect(isClientPushConfigured()).toBe(false);
    await expect(sendClientPush({ userId: "u1", title: "t", body: "b" })).resolves.toEqual({ sent: 0, skipped: 0 });
  });

  it("sends to iOS tokens and never hands Android tokens to Apple", async () => {
    const send = vi.fn(async () => {});
    __setClientPushProvider({ send } as never);
    const result = await sendClientPush({ userId: "u1", title: "Approved", body: "Your file moved" });
    expect(result).toEqual({ sent: 1, skipped: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ token: "ios-token" });
  });
});
