// BF_SERVER_KS_WIDGET_INBOX_UNREAD_v1
import { describe, expect, it, vi } from "vitest";
import { ksInboxUnread } from "../ksWidget.js";

const q = (rows: unknown[]) => ({ query: vi.fn(async () => ({ rows })) }) as any;

describe("Keystone widget unread = unread email in the Keystone shared mailboxes", () => {
  it("adds up the Inbox unread count of every Keystone mailbox", async () => {
    const fetch = vi.fn(async (path: string) => new Response(JSON.stringify({ unreadItemCount: path.includes("sales") ? 2 : 1 }), { status: 200 }));
    const n = await ksInboxUnread(q([{ address: "sales@keystonecrm.online" }, { address: "info@keystonecrm.online" }]), "u1", async () => ({ fetch }));
    expect(n).toBe(3);
    expect(fetch.mock.calls[0]![0]).toBe("/users/sales%40keystonecrm.online/mailFolders/inbox?$select=unreadItemCount");
  });

  it("gives null (use the old count) when Microsoft 365 is not connected or refuses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await ksInboxUnread(q([{ address: "sales@keystonecrm.online" }]), "u1", async () => null)).toBeNull();
    expect(await ksInboxUnread(q([{ address: "sales@keystonecrm.online" }]), "u1", async () => ({ fetch: async () => new Response("", { status: 403 }) }))).toBeNull();
    expect(await ksInboxUnread(q([]), "u1", async () => null)).toBeNull();
    warn.mockRestore();
  });
});
