-- BF_SERVER_JOURNEY_BACKFILL_v76
-- v75 stitches visitor_sessions to a contact at application START. Before that,
-- stitching only happened at SUBMIT, so every abandoned application left its whole
-- browsing journey orphaned in visitor_events with no contact_id. Those rows are
-- still there. This links them retroactively so the CRM Visitor Journey panel fills
-- in for the people who started and did not finish - the exact records being called.
--
-- Idempotent: only ever writes rows where contact_id IS NULL, so a re-run is a no-op.

-- Pass 1: exact journey session id carried on the application's attribution.
UPDATE visitor_sessions vs
   SET contact_id = a.contact_id::text,
       stitched_at = now()
  FROM applications a
 WHERE vs.contact_id IS NULL
   AND a.contact_id IS NOT NULL
   AND COALESCE(a.metadata->'attribution'->>'sessionId', '') <> ''
   AND vs.session_id = a.metadata->'attribution'->>'sessionId';

-- Pass 2: gclid fallback, for sessions that predate the sessionId handoff.
-- Deliberately restricted to gclids belonging to exactly ONE application: a gclid
-- shared across two applications cannot be attributed to one contact without
-- guessing, and a wrong journey on a CRM record is worse than no journey.
UPDATE visitor_sessions vs
   SET contact_id = m.contact_id::text,
       stitched_at = now()
  FROM (
    SELECT a.metadata->'attribution'->>'gclid' AS gclid,
           MIN(a.contact_id::text)             AS contact_id
      FROM applications a
     WHERE a.contact_id IS NOT NULL
       AND COALESCE(a.metadata->'attribution'->>'gclid', '') <> ''
     GROUP BY 1
    HAVING COUNT(DISTINCT a.contact_id) = 1
  ) m
 WHERE vs.contact_id IS NULL
   AND COALESCE(vs.gclid, '') <> ''
   AND vs.gclid = m.gclid;
