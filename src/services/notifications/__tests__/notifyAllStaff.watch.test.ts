import { beforeEach, describe, expect, it, vi } from "vitest";

const watchSend = vi.fn();
const browserSend = vi.fn();
const smsSend = vi.fn();
import { notifyAllStaff } from "../notifyAllStaff.js";

const deps = () => ({ sendWatchNotification: watchSend, pushToUser: browserSend, sendSMS: smsSend });

function pool() {
  return { query: vi.fn(async (sql: string) => sql.includes("FROM users")
    ? { rows: [{ id: "u1", phone_number: "+15550000001", email: null }, { id: "u2", phone_number: null, email: null }] }
    : { rows: [] }) } as any;
}

beforeEach(() => { vi.clearAllMocks(); smsSend.mockResolvedValue({ success: true }); watchSend.mockResolvedValue(1); });

describe("notifyAllStaff Watch opt-in", () => {
  it("preserves existing fan-out and does not attempt Watch without ctx.watch", async () => {
    const db = pool();
    const result = await notifyAllStaff({ pool: db, notificationType: "existing", title: "Title", body: "Body" }, deps() as any);
    expect(result).toEqual({ smsSent: 1, notifsCreated: 2, recipientCount: 2 });
    expect(browserSend).toHaveBeenCalledTimes(2);
    expect(watchSend).not.toHaveBeenCalled();
  });

  it("attempts safe typed Watch delivery for every recipient without changing other channels", async () => {
    const db = pool();
    const result = await notifyAllStaff({ pool: db, notificationType: "sms_inbound", title: "Long normal copy", body: "Normal body",
      watch: { category: "MESSAGE", eventType: "client_message", title: "New message", body: "New client message", resourceId: "opaque" } }, deps() as any);
    expect(result).toEqual({ smsSent: 1, notifsCreated: 2, recipientCount: 2 });
    expect(watchSend).toHaveBeenCalledTimes(2);
    expect(watchSend).toHaveBeenCalledWith(expect.objectContaining({ staffUserId: "u1", body: "New client message", resourceId: "opaque" }));
    expect(browserSend).toHaveBeenCalledTimes(2);
    expect(smsSend).toHaveBeenCalledTimes(1);
  });

  it("isolates Watch failures from notification records and business callers", async () => {
    watchSend.mockRejectedValue(new Error("provider unavailable"));
    const db = pool();
    await expect(notifyAllStaff({ pool: db, notificationType: "task", body: "Task", watch: { category: "TASK", eventType: "task" } }, deps() as any))
      .resolves.toEqual({ smsSent: 1, notifsCreated: 2, recipientCount: 2 });
    expect(db.query.mock.calls.filter(([sql]: [string]) => sql.includes("INSERT INTO notifications"))).toHaveLength(2);
  });
});
