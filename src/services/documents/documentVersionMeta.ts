// BF_SERVER_DOC_META_SIZE_v42
// Pure helpers for reconciling version metadata with document-row fallbacks.

export type DocumentVersionMeta = {
  fileName?: unknown;
  mimeType?: unknown;
  size?: unknown;
  sizeBytes?: unknown;
  storageKey?: unknown;
};

export function readDocumentVersionMeta(metadata: unknown): DocumentVersionMeta {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as DocumentVersionMeta;
}

function toPositiveInt(raw: unknown): number | null {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function toTrimmedString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

// sizeBytes is what the uploader writes; size remains supported for older rows.
export function resolveDocumentSizeBytes(
  metadata: unknown,
  row?: { size_bytes?: unknown },
): number | null {
  const meta = readDocumentVersionMeta(metadata);
  return toPositiveInt(meta.sizeBytes) ?? toPositiveInt(meta.size) ?? toPositiveInt(row?.size_bytes);
}

export function resolveDocumentFilename(
  metadata: unknown,
  row: { filename?: string | null; title?: string | null },
): string | null {
  const meta = readDocumentVersionMeta(metadata);
  return toTrimmedString(meta.fileName) ?? toTrimmedString(row.filename) ?? toTrimmedString(row.title);
}

export function resolveDocumentStorageKey(
  metadata: unknown,
  row: { storage_key?: string | null },
): string | null {
  const meta = readDocumentVersionMeta(metadata);
  return toTrimmedString(meta.storageKey) ?? toTrimmedString(row.storage_key);
}

export function resolveDocumentMimeType(metadata: unknown): string | null {
  return toTrimmedString(readDocumentVersionMeta(metadata).mimeType);
}
