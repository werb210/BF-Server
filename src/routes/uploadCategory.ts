// BF_SERVER_BLOCK_v843_UPLOAD_CATEGORY_FIELD_COMPAT
// The document-upload routes historically read only `req.body.category`. The
// mini-portal DocPicker (bf-client) posts the same value under the field name
// `document_type`, so `category` came back null and the route returned
// 400 INVALID_DOCUMENT_UPLOAD_PAYLOAD on every CMP upload. Other client
// uploaders (api/applications.ts, api/documents.ts, utils/uploadDocument.ts)
// send `category`. Accept every spelling so no caller can break, regardless of
// which one a given screen happens to use.
//
// Pure + dependency-free on purpose: unit-testable without importing the route
// module (which pulls in db.ts and trips the DB_NOT_READY gate in CI/sandbox).
export function resolveUploadCategory(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  for (const key of ["category", "document_type", "documentType"]) {
    const v = b[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
