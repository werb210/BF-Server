"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNotification = createNotification;
const db_1 = require("../../db");
async function createNotification(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`insert into notifications
     (id, user_id, application_id, type, title, body, metadata, created_at, read_at)
     values ($1, $2, $3, $4, $5, $6, $7, now(), null)
     returning id, user_id, application_id, type, title, body, metadata, created_at, read_at`, [
        params.notificationId,
        params.userId,
        params.applicationId,
        params.type,
        params.title,
        params.body,
        params.metadata ?? null,
    ]);
    const record = result.rows[0];
    if (!record) {
        throw new Error("Failed to create notification.");
    }
    return record;
}
