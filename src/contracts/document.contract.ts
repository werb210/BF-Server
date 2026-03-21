export const DOCUMENT_CONTRACT = {
  UPLOAD: "/api/documents/upload",
  REQUIRED_FIELDS: ["file", "applicationId", "category"] as const,
} as const;
