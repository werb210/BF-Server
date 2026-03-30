"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializePushService = initializePushService;
exports.validatePushEnvironmentAtStartup = validatePushEnvironmentAtStartup;
exports.fetchPushStatus = fetchPushStatus;
exports.sendNotification = sendNotification;
const web_push_1 = __importDefault(require("web-push"));
const crypto_1 = require("crypto");
const config_1 = require("../config");
const pwa_repo_1 = require("../repositories/pwa.repo");
const errors_1 = require("../middleware/errors");
const logger_1 = require("../observability/logger");
const appInsights_1 = require("../observability/appInsights");
const requestContext_1 = require("../observability/requestContext");
let pushConfigured = false;
let pushInitAttempted = false;
let cachedStatus = { configured: false, enabled: true };
const DEFAULT_TTL_SECONDS = 3600;
const HIGH_TTL_SECONDS = 24 * 3600;
const CRITICAL_VIBRATE_PATTERN = [200, 100, 200, 100, 200];
function hashPayload(payload) {
    return (0, crypto_1.createHash)("sha256").update(JSON.stringify(payload)).digest("hex");
}
function ensurePayloadSize(payload) {
    const maxBytes = config_1.config.pwa.pushPayloadMaxBytes;
    const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (size > maxBytes) {
        throw new errors_1.AppError("payload_too_large", `Push payload exceeds ${maxBytes} bytes.`, 413);
    }
}
function buildWebPushPayload(payload, target) {
    if (payload.type === "alert") {
        const isHigh = payload.level === "high" || payload.level === "critical";
        const isCritical = payload.level === "critical";
        const base = {
            type: payload.type,
            title: payload.title,
            body: payload.body,
            level: payload.level,
            sound: payload.sound,
            badge: payload.badge,
            data: payload.data,
            vibrate: isCritical ? CRITICAL_VIBRATE_PATTERN : [],
            userRole: target.role,
            sentAt: new Date().toISOString(),
        };
        if (isHigh) {
            base.requireInteraction = true;
        }
        if (isCritical) {
            base.requireInteraction = true;
            base.renotify = true;
        }
        return base;
    }
    if (payload.type === "badge") {
        return {
            type: payload.type,
            badgeIncrement: payload.increment,
            silent: true,
            contentAvailable: true,
            userRole: target.role,
            sentAt: new Date().toISOString(),
        };
    }
    return {
        type: payload.type,
        data: payload.data,
        badgeIncrement: payload.badgeIncrement ?? null,
        silent: true,
        contentAvailable: true,
        userRole: target.role,
        sentAt: new Date().toISOString(),
    };
}
function fetchAuditEntry(payload) {
    if (payload.type === "alert") {
        return {
            level: payload.level,
            title: payload.title,
            body: payload.body,
        };
    }
    if (payload.type === "badge") {
        return {
            level: "badge",
            title: "Badge updated",
            body: `Incremented badge by ${payload.increment}.`,
        };
    }
    return {
        level: "silent",
        title: "Silent update",
        body: "Background update delivered.",
    };
}
function shouldDeleteSubscription(statusCode) {
    return statusCode === 404 || statusCode === 410 || statusCode === 400;
}
function isPushEnabled() {
    const raw = config_1.config.pwa.pushEnabled;
    if (raw === undefined) {
        return true;
    }
    return raw.trim().toLowerCase() === "true";
}
function initializePushService() {
    if (pushInitAttempted) {
        return cachedStatus;
    }
    pushInitAttempted = true;
    const enabled = isPushEnabled();
    if (!enabled) {
        cachedStatus = { configured: false, enabled, error: "push_disabled" };
        (0, logger_1.logInfo)("push_disabled", {});
        return cachedStatus;
    }
    const publicKey = config_1.config.security.vapidPublicKey;
    const privateKey = config_1.config.security.vapidPrivateKey;
    const subject = config_1.config.security.vapidSubject;
    if (!publicKey || !privateKey || !subject) {
        const error = "missing_vapid";
        cachedStatus = {
            configured: false,
            enabled,
            error,
            subject,
        };
        if (config_1.config.isProduction) {
            throw new Error("VAPID configuration is required in production when push is enabled.");
        }
        (0, logger_1.logWarn)("push_vapid_missing", { subject: subject ?? null, publicKey: Boolean(publicKey) });
        return cachedStatus;
    }
    try {
        web_push_1.default.setVapidDetails(subject, publicKey, privateKey);
        pushConfigured = true;
        cachedStatus = {
            configured: true,
            enabled,
            subject,
        };
        (0, logger_1.logInfo)("push_initialized", { subject });
        return cachedStatus;
    }
    catch (error) {
        const status = {
            configured: false,
            enabled,
            error: error instanceof Error ? error.message : "invalid_vapid",
            subject,
        };
        cachedStatus = status;
        if (config_1.config.isProduction) {
            throw error instanceof Error ? error : new Error("invalid_vapid");
        }
        (0, logger_1.logWarn)("push_init_failed", {
            error: error instanceof Error ? error.message : "unknown_error",
        });
        return cachedStatus;
    }
}
function validatePushEnvironmentAtStartup() {
    initializePushService();
}
function fetchPushStatus() {
    if (!pushInitAttempted) {
        return initializePushService();
    }
    return cachedStatus;
}
async function sendNotification(target, payload) {
    initializePushService();
    if (!pushConfigured) {
        throw new errors_1.AppError("push_not_configured", "Push notifications are not configured.", 503);
    }
    ensurePayloadSize(payload);
    const subscriptions = await (0, pwa_repo_1.listPwaSubscriptionsByUser)(target.userId);
    const requestId = (0, requestContext_1.fetchRequestContext)()?.requestId ?? "unknown";
    const messagePayload = buildWebPushPayload(payload, target);
    const payloadHash = hashPayload(messagePayload);
    const auditEntry = fetchAuditEntry(payload);
    await (0, pwa_repo_1.createPwaNotificationAudit)({
        userId: target.userId,
        level: auditEntry.level,
        title: auditEntry.title,
        body: auditEntry.body,
        deliveredAt: new Date(),
        payloadHash,
    });
    if (subscriptions.length === 0) {
        (0, logger_1.logWarn)("push_no_subscriptions", {
            userId: target.userId,
            role: target.role,
            requestId,
        });
        return { sent: 0, failed: 0 };
    }
    let sent = 0;
    let failed = 0;
    const isAlert = payload.type === "alert";
    const ttl = isAlert
        ? payload.level === "normal"
            ? DEFAULT_TTL_SECONDS
            : HIGH_TTL_SECONDS
        : DEFAULT_TTL_SECONDS;
    const urgency = isAlert && payload.level !== "normal" ? "high" : "normal";
    for (const subscription of subscriptions) {
        try {
            await web_push_1.default.sendNotification({
                endpoint: subscription.endpoint,
                keys: {
                    p256dh: subscription.p256dh,
                    auth: subscription.auth,
                },
            }, JSON.stringify(messagePayload), {
                TTL: ttl,
                urgency,
            });
            sent += 1;
            (0, appInsights_1.trackEvent)({
                name: "push_sent",
                properties: {
                    userId: target.userId,
                    role: target.role,
                    requestId,
                    endpoint: subscription.endpoint,
                    payloadType: payload.type,
                },
            });
            (0, logger_1.logInfo)("push_sent", {
                userId: target.userId,
                role: target.role,
                requestId,
                endpoint: subscription.endpoint,
                payloadType: payload.type,
            });
        }
        catch (error) {
            failed += 1;
            const statusCode = error?.statusCode;
            if (shouldDeleteSubscription(statusCode)) {
                await (0, pwa_repo_1.deletePwaSubscriptionByEndpoint)({
                    userId: target.userId,
                    endpoint: subscription.endpoint,
                });
            }
            (0, appInsights_1.trackEvent)({
                name: "push_failed",
                properties: {
                    userId: target.userId,
                    role: target.role,
                    requestId,
                    endpoint: subscription.endpoint,
                    payloadType: payload.type,
                    statusCode: statusCode ?? "unknown",
                },
            });
            (0, logger_1.logError)("push_failed", {
                userId: target.userId,
                role: target.role,
                requestId,
                endpoint: subscription.endpoint,
                payloadType: payload.type,
                statusCode: statusCode ?? "unknown",
                message: error instanceof Error ? error.message : "unknown_error",
            });
        }
    }
    return { sent, failed };
}
