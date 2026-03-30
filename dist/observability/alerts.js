"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSlackAlert = sendSlackAlert;
const config_1 = require("../config");
const logger_1 = require("../platform/logger");
async function sendSlackAlert(message) {
    const webhookUrl = config_1.config.alerting.slackWebhookUrl;
    if (!webhookUrl) {
        logger_1.logger.warn("slack_alert_not_configured");
        return;
    }
    const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ text: `[BF-Server] ${message}` }),
    });
    if (!response.ok) {
        const responseBody = await response.text();
        logger_1.logger.error("slack_alert_delivery_failed", {
            status: response.status,
            responseBody,
        });
    }
}
