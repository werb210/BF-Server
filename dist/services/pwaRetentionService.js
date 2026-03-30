"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPwaNotificationRetention = runPwaNotificationRetention;
const pwa_repo_1 = require("../repositories/pwa.repo");
async function runPwaNotificationRetention(retentionDays = 30) {
    const normalizedDays = Number.isFinite(retentionDays)
        ? Math.max(1, Math.floor(retentionDays))
        : 30;
    const purged = await (0, pwa_repo_1.purgeOldPwaNotifications)(normalizedDays);
    return { purged };
}
