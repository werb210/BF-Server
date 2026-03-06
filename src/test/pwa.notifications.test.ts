import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../db";
import {
  acknowledgePwaNotification,
  createPwaNotificationAudit,
  listPwaNotificationsForUser,
  upsertPwaSubscription,
  deletePwaSubscription,
  deletePwaSubscriptionLegacy,
} from "../repositories/pwa.repo";

const USER_ID = "00000000-0000-0000-0000-000000000001";

describe("pwa notifications repo", () => {
    beforeEach(async () => {
    await pool.query("delete from pwa_notifications");
    await pool.query("delete from pwa_subscriptions");
    await pool.query("delete from users where id = $1", [USER_ID]);
    await pool.query(
      `insert into users (id, email, phone_number, password_hash, role, active, password_changed_at)
       values ($1, 'pwa-user@test.local', '+14155550111', 'x', 'Admin', true, now())`,
      [USER_ID]
    );
  });

  it("supports notification pagination", async () => {
    for (let i = 0; i < 3; i += 1) {
      await createPwaNotificationAudit({
        userId: USER_ID,
        level: "normal",
        title: `n-${i}`,
        body: "test",
        deliveredAt: new Date(Date.now() + i * 1000),
        payloadHash: `hash-${i}`,
      });
    }

    const page = await listPwaNotificationsForUser({ userId: USER_ID, limit: 2, offset: 0 });
    expect(page.notifications).toHaveLength(2);
    expect(page.total).toBe(3);

    const page2 = await listPwaNotificationsForUser({ userId: USER_ID, limit: 2, offset: 2 });
    expect(page2.notifications).toHaveLength(1);
  });

  it("deduplicates notification audit records in short window", async () => {
    const first = await createPwaNotificationAudit({
      userId: USER_ID,
      level: "normal",
      title: "Same",
      body: "Same",
      deliveredAt: new Date(),
      payloadHash: "same-hash",
      duplicateWindowSeconds: 120,
    });

    const second = await createPwaNotificationAudit({
      userId: USER_ID,
      level: "normal",
      title: "Same",
      body: "Same",
      deliveredAt: new Date(),
      payloadHash: "same-hash",
      duplicateWindowSeconds: 120,
    });

    expect(second.id).toBe(first.id);
    const count = await pool.query<{ count: number }>(
      "select count(*)::int as count from pwa_notifications where user_id = $1",
      [USER_ID]
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("acks only once", async () => {
    const notification = await createPwaNotificationAudit({
      userId: USER_ID,
      level: "normal",
      title: "Ack",
      body: "Ack",
      deliveredAt: new Date(),
      payloadHash: "ack-hash",
    });

    const first = await acknowledgePwaNotification({
      userId: USER_ID,
      notificationId: notification.id,
    });
    const second = await acknowledgePwaNotification({
      userId: USER_ID,
      notificationId: notification.id,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("supports owned and legacy unsubscribe variants", async () => {
    await upsertPwaSubscription({
      userId: USER_ID,
      endpoint: "https://example.com/1",
      p256dh: "p",
      auth: "a",
      deviceType: "desktop",
    });

    const ownedRemoved = await deletePwaSubscription({
      userId: USER_ID,
      endpoint: "https://example.com/1",
    });
    expect(ownedRemoved).toBe(true);

    await upsertPwaSubscription({
      userId: USER_ID,
      endpoint: "https://example.com/1",
      p256dh: "p",
      auth: "a",
      deviceType: "desktop",
    });

    const legacyRemoved = await deletePwaSubscriptionLegacy("https://example.com/1");
    expect(legacyRemoved).toBe(true);
  });
});
