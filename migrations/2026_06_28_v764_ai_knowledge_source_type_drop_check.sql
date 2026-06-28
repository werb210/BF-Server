-- BF_AI_KNOWLEDGE_SOURCE_TYPE_DROP_CHECK_v1
-- Root cause of the AI Knowledge "Upload failed." 500: ai_knowledge was first created by
-- migration 061 with a CHECK constraint limiting source_type to
-- ('spec_sheet','faq','internal','product'). Later definitions (094/095) that omit the CHECK
-- are no-ops because the table already exists. The app's embedAndStore() writes source_type
-- values of 'sheet' (file upload), 'text' (paste), 'url' (train-from-URL), 'rule', and the
-- ':no-embed' / ':embed-failed' fallbacks -- none of which satisfy the CHECK -- so every insert
-- raised Postgres 23514 (check_violation), an uncoded error the route surfaced as a 500.
-- Fix: drop the stale CHECK (source_type is free-form in current code) and defensively ensure
-- the columns the insert needs exist. All operations are idempotent and safe to re-run.

create extension if not exists vector;

alter table if exists ai_knowledge
  add column if not exists title text,
  add column if not exists source_id text,
  add column if not exists embedding vector(1536);

DO $$
DECLARE c record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ai_knowledge') THEN
    FOR c IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'ai_knowledge'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%source_type%'
    LOOP
      EXECUTE format('ALTER TABLE ai_knowledge DROP CONSTRAINT %I', c.conname);
    END LOOP;
  END IF;
END $$;
