import { randomUUID } from "node:crypto";
import { createNotification } from "./notifications.repo.js";

export async function notifyOcrWarnings(params: {
  applicationId: string;
  missingFields: string[];
  conflictingFields: string[];
}): Promise<void> {
  if (params.missingFields.length === 0 && params.conflictingFields.length === 0) {
    return;
  }

  const bodyParts: string[] = [];
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

// BF_SERVER_DOC_CLASSIFY_v140
export type DocumentMismatchInput = {
  applicationId: string;
  documentId: string;
  expected: string;
  detected: string;
  confidence: number;
  reason: string;
};

/**
 * Pure construction of the mismatch notification row, separated from the write
 * so the wording and metadata can be tested without a database.
 */
export function buildDocumentMismatchNotification(params: DocumentMismatchInput) {
  return {
    notificationId: randomUUID(),
    userId: null,
    applicationId: params.applicationId,
    type: "DOCUMENT_TYPE_MISMATCH",
    title: "Uploaded document may be the wrong type",
    body:
      `A document uploaded as "${params.expected}" looks like a "${params.detected}" ` +
      `(confidence ${Math.round(params.confidence * 100)}%). ${params.reason}`,
    metadata: {
      documentId: params.documentId,
      expected: params.expected,
      detected: params.detected,
      confidence: params.confidence,
      reason: params.reason,
      audience: "staff",
    },
  };
}

/**
 * Raised when the classifier is confident a document is not the type it was
 * uploaded against. Audience is staff, never the applicant: the classifier is
 * a heuristic, and telling someone their correct document is wrong costs more
 * than a staff member glancing at a flag.
 */
export async function notifyDocumentMismatch(params: DocumentMismatchInput): Promise<void> {
  await createNotification(buildDocumentMismatchNotification(params));
}
