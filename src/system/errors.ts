// BF_SERVER_SAFE_PROCESS_ERROR_LOGGING_v1
// These two handlers used to `console.error(tag, e)` with the RAW error object.
// src/index.ts already registers its own handlers and deliberately logs only
// message + code + stack, with this comment above them:
//
//   "never console.error the raw error object: pg errors reference the live
//    Connection (TLSSocket, processID, secretKey, query queue), so logging the
//    object leaked DB credentials into the Azure log stream and flooded it."
//
// That rule was applied to index.ts and missed here. Node runs EVERY registered
// handler, so both fired on the same error and this one undid the redaction. A
// single Postgres ETIMEDOUT printed the whole pg Client to the Azure log stream:
//
//   user: 'borealadmin'
//   host: 'boreal-pg01-recovery.postgres.database.azure.com'
//   database: 'postgres', port: 5432
//   processID: 219587, secretKey: -1853604146
//
// secretKey + processID together are the pg cancel-request credentials for that
// backend, and anyone with log-stream access could read them. It also buried the
// real error under ~60 lines of object dump on every occurrence.
//
// Same redaction as index.ts. Keeping the handlers registered still prevents the
// process exiting on an uncaught error; only the logging changes.
function safeLog(tag: string, err: unknown): void {
  const e = err as { message?: unknown; code?: unknown; stack?: string } | null | undefined;
  const code = e && e.code != null ? ` (${String(e.code)})` : "";
  console.error(tag, String(e?.message ?? err) + code);
  if (e?.stack) console.error(e.stack);
}

process.on("unhandledRejection", (e) => {
  safeLog("[UNHANDLED REJECTION]", e);
});

process.on("uncaughtException", (e) => {
  safeLog("[UNCAUGHT EXCEPTION]", e);
});
