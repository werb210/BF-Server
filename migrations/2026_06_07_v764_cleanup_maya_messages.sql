-- 2026_06_07_v764_cleanup_maya_messages.sql
-- BF_SERVER_BLOCK_v764 — one-time cleanup of the Messages tab. Earlier code
-- wrote Maya AI auto-handoffs and report-issue rows into communications_messages.
-- v763 stops creating them; this removes the historical ones. They remain
-- available in the Maya tab (chat_sessions) and the Issues tab. Runs exactly
-- once (tracked in schema_migrations); logs counts to the server log.
DO $$
DECLARE n integer;
BEGIN
  DELETE FROM communications_messages WHERE type = 'maya_handoff';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'v764 cleanup: removed % maya_handoff rows', n;

  DELETE FROM communications_messages
   WHERE type = 'message' AND channel = 'messenger' AND body LIKE '[Issue]%';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'v764 cleanup: removed % report-issue messenger rows', n;

  DELETE FROM communications_messages
   WHERE type = 'message' AND channel = 'messenger'
     AND body LIKE '%Maya:%'
     AND (body LIKE '%Visitor:%' OR body LIKE '%Client:%');
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'v764 cleanup: removed % Maya-transcript talk-to-human rows', n;
END $$;
