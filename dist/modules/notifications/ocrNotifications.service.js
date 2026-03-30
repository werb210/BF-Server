"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyOcrWarnings = notifyOcrWarnings;
const crypto_1 = require("crypto");
const notifications_repo_1 = require("./notifications.repo");
async function notifyOcrWarnings(params) {
    if (params.missingFields.length === 0 && params.conflictingFields.length === 0) {
        return;
    }
    const bodyParts = [];
    if (params.missingFields.length > 0) {
        bodyParts.push(`Missing fields: ${params.missingFields.join(", ")}`);
    }
    if (params.conflictingFields.length > 0) {
        bodyParts.push(`Conflicting fields: ${params.conflictingFields.join(", ")}`);
    }
    await (0, notifications_repo_1.createNotification)({
        notificationId: (0, crypto_1.randomUUID)(),
        userId: null,
        applicationId: params.applicationId,
        type: "OCR_WARNING",
        title: "OCR insights need review",
        body: bodyParts.join(". "),
        metadata: {
            missingFields: params.missingFields,
            conflictingFields: params.conflictingFields,
            audience: "staff",
        },
    });
}
