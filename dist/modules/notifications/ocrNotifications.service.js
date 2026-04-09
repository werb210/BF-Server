import { randomUUID } from "node:crypto";
import { createNotification } from "./notifications.repo.js";
export async function notifyOcrWarnings(params) {
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
    await createNotification({
        notificationId: randomUUID(),
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
