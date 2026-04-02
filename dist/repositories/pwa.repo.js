"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertPwaSubscription = upsertPwaSubscription;
exports.deletePwaSubscription = deletePwaSubscription;
exports.deletePwaSubscriptionLegacy = deletePwaSubscriptionLegacy;
exports.listPwaSubscriptionsByUser = listPwaSubscriptionsByUser;
exports.listPwaSubscriptions = listPwaSubscriptions;
exports.deletePwaSubscriptionByEndpoint = deletePwaSubscriptionByEndpoint;
exports.createPwaNotificationAudit = createPwaNotificationAudit;
exports.listPwaNotificationsForUser = listPwaNotificationsForUser;
exports.acknowledgePwaNotification = acknowledgePwaNotification;
exports.purgeOldPwaNotifications = purgeOldPwaNotifications;
const crypto_1 = require("crypto");
const db_1 = require("../db");
const errors_1 = require("../middleware/errors");
async function upsertPwaSubscription(params) {
    const existing = await (0, db_1.runQuery)(`select id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at
     from pwa_subscriptions
     where endpoint = $1
     limit 1`, [params.endpoint]);
    const row = existing.rows[0];
    if (row && row.user_id !== params.userId) {
        throw new errors_1.AppError("endpoint_in_use", "Subscription endpoint is already registered.", 409);
    }
    if (row) {
        const updated = await (0, db_1.runQuery)(`update pwa_subscriptions
       set p256dh = $1,
           auth = $2,
           device_type = $3,
           updated_at = now()
       where id = $4
       returning id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at`, [params.p256dh, params.auth, params.deviceType, row.id]);
        const updatedRow = updated.rows[0];
        if (!updatedRow) {
            throw new Error("Failed to update PWA subscription.");
        }
        return updatedRow;
    }
    const created = await (0, db_1.runQuery)(`insert into pwa_subscriptions
     (id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, now(), now())
     returning id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at`, [
        (0, crypto_1.randomUUID)(),
        params.userId,
        params.endpoint,
        params.p256dh,
        params.auth,
        params.deviceType,
    ]);
    const createdRow = created.rows[0];
    if (!createdRow) {
        throw new Error("Failed to create PWA subscription.");
    }
    return createdRow;
}
async function deletePwaSubscription(params) {
    const result = await (0, db_1.runQuery)(`delete from pwa_subscriptions
     where user_id = $1 and endpoint = $2`, [params.userId, params.endpoint]);
    return (result.rowCount ?? 0) > 0;
}
async function deletePwaSubscriptionLegacy(endpoint) {
    const result = await (0, db_1.runQuery)(`delete from pwa_subscriptions
     where endpoint = $1`, [endpoint]);
    return (result.rowCount ?? 0) > 0;
}
async function listPwaSubscriptionsByUser(userId) {
    const result = await (0, db_1.runQuery)(`select id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at
     from pwa_subscriptions
     where user_id = $1
     order by updated_at desc`, [userId]);
    return result.rows;
}
async function listPwaSubscriptions() {
    const result = await (0, db_1.runQuery)(`select id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at
     from pwa_subscriptions
     order by updated_at desc`);
    return result.rows;
}
async function deletePwaSubscriptionByEndpoint(params) {
    await (0, db_1.runQuery)(`delete from pwa_subscriptions
     where user_id = $1 and endpoint = $2`, [params.userId, params.endpoint]);
}
async function createPwaNotificationAudit(params) {
    const duplicateWindowSeconds = params.duplicateWindowSeconds ?? 120;
    const existing = await (0, db_1.runQuery)(`select id, user_id, level, title, body, delivered_at, acknowledged_at, payload_hash
     from pwa_notifications
     where user_id = $1
       and payload_hash = $2
     order by delivered_at desc
     limit 1`, [params.userId, params.payloadHash]);
    const latest = existing.rows[0];
    if (latest) {
        const cutoff = Date.now() - duplicateWindowSeconds * 1000;
        if (new Date(latest.delivered_at).getTime() >= cutoff) {
            return latest;
        }
    }
    const result = await (0, db_1.runQuery)(`insert into pwa_notifications
     (id, user_id, level, title, body, delivered_at, acknowledged_at, payload_hash)
     values ($1, $2, $3, $4, $5, $6, null, $7)
     returning id, user_id, level, title, body, delivered_at, acknowledged_at, payload_hash`, [
        (0, crypto_1.randomUUID)(),
        params.userId,
        params.level,
        params.title,
        params.body,
        params.deliveredAt,
        params.payloadHash,
    ]);
    const notification = result.rows[0];
    if (!notification) {
        throw new Error("Failed to create PWA notification.");
    }
    return notification;
}
async function listPwaNotificationsForUser(params) {
    const [result, countResult] = await Promise.all([
        (0, db_1.runQuery)(`select id, user_id, level, title, body, delivered_at, acknowledged_at, payload_hash
       from pwa_notifications
       where user_id = $1
       order by delivered_at desc
       limit $2
       offset $3`, [params.userId, params.limit, params.offset]),
        (0, db_1.runQuery)(`select count(*)::int as count
       from pwa_notifications
       where user_id = $1`, [params.userId]),
    ]);
    return {
        notifications: result.rows,
        total: countResult.rows[0]?.count ?? 0,
    };
}
async function acknowledgePwaNotification(params) {
    const result = await (0, db_1.runQuery)(`update pwa_notifications
     set acknowledged_at = now()
     where id = $1 and user_id = $2 and acknowledged_at is null`, [params.notificationId, params.userId]);
    return (result.rowCount ?? 0) > 0;
}
async function purgeOldPwaNotifications(retentionDays) {
    const result = await (0, db_1.runQuery)(`delete from pwa_notifications
     where delivered_at < now() - ($1::text || ' days')::interval`, [retentionDays]);
    return result.rowCount ?? 0;
}
