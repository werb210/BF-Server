// BF_SERVER_BLOCK_v_SAFE_ERROR_LOGGING_v2
// Format an error for logs WITHOUT dumping the object. node-postgres errors
// reference the live Connection (TLSSocket, processID, secretKey, query queue),
// so console.error(tag, err) leaked DB credentials into the log stream.
export function safeErr(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown } | null | undefined;
  const code = e && e.code != null ? ` (${String(e.code)})` : "";
  return String(e?.message ?? err) + code;
}
