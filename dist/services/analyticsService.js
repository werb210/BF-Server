"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAnalyticsEvent = logAnalyticsEvent;
const db_1 = require("../db");
const logger_1 = require("../observability/logger");
async function logAnalyticsEvent({ event, metadata = {}, ip, userAgent, }) {
    await (0, db_1.dbQuery)(`insert into analytics_events (event, metadata, ip, user_agent)
     values ($1, $2::jsonb, $3, $4)`, [event, JSON.stringify(metadata), ip ?? null, userAgent ?? null]);
    (0, logger_1.logInfo)("audit_analytics_event_logged", {
        event,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
    });
}
