-- BF_SERVER_TEAMS_MEETINGS_UPSERT_FIX_v1
-- 2026_07_12_teams_meetings.sql created a PARTIAL unique index:
--   CREATE UNIQUE INDEX ... (graph_event_id) WHERE graph_event_id IS NOT NULL
-- but the INSERT in crm/meetings.ts used `ON CONFLICT (graph_event_id)` with no
-- index predicate. Postgres cannot infer a partial unique index unless the
-- predicate is repeated on the ON CONFLICT clause, so every insert raised
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" - and the caller swallowed it, so teams_meetings stayed empty
-- with no error surfaced anywhere.
-- Fix: use a plain (non-partial) unique index. Postgres already allows multiple
-- NULLs in a unique index, so this keeps the same semantics AND is inferable by
-- a bare `ON CONFLICT (graph_event_id)`.
DROP INDEX IF EXISTS teams_meetings_graph_event_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS teams_meetings_graph_event_uidx
  ON teams_meetings (graph_event_id);
