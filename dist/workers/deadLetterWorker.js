"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processDeadLetters = processDeadLetters;
exports.startDeadLetterWorker = startDeadLetterWorker;
const db_1 = require("../db");
const retry_1 = require("../lib/retry");
const sms_service_1 = require("../modules/notifications/sms.service");
const crmWebhook_1 = require("../services/crmWebhook");
const alerts_1 = require("../observability/alerts");
async function processJob(job) {
    switch (job.type) {
        case "sms":
            await (0, sms_service_1.sendSms)(job.data);
            return;
        case "partner_webhook":
            await (0, crmWebhook_1.pushLeadToCRM)(job.data);
            return;
        case "slack_webhook":
            await (0, alerts_1.sendSlackAlert)(String(job.data?.message ?? ""));
            return;
        default:
            throw new Error(`unknown_dead_letter_job_type:${job.type}`);
    }
}
async function processDeadLetters() {
    const MAX_RETRIES = 10;
    const res = await db_1.pool.query(`SELECT * FROM failed_jobs ORDER BY created_at ASC LIMIT 20`);
    for (const job of res.rows) {
        if (job.retry_count >= MAX_RETRIES) {
            console.error("Dead letter abandoned", job.id);
            continue;
        }
        try {
            await (0, retry_1.withRetry)(async () => {
                await processJob(job);
            });
            await db_1.pool.query(`DELETE FROM failed_jobs WHERE id = $1`, [job.id]);
        }
        catch {
            await db_1.pool.query(`UPDATE failed_jobs SET retry_count = retry_count + 1 WHERE id = $1`, [job.id]);
        }
    }
}
async function safeProcess() {
    try {
        await processDeadLetters();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("dead-letter-failed", message);
    }
}
function startDeadLetterWorker() {
    return setInterval(safeProcess, 15000);
}
