-- BF_SERVER_v789_AUDIT_ROUND2
-- Every statement here is idempotent (IF NOT EXISTS / NOT EXISTS guards) so a
-- re-run is a no-op. Sections are grouped by audit area.


-- ===== [A] auth: token tickets, conversation tokens =====



-- ===== [B] client / public access =====

-- BF_SERVER_v789_CONVERSATION_TOKENS - visitor credentials for the public
-- conversation read/post endpoints. Only the sha256 of the token is stored.
-- conversation_id matches communications_conversations.id (uuid).
CREATE TABLE IF NOT EXISTS public_conversation_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES communications_conversations(id) ON DELETE CASCADE,
  token_hash      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS public_conversation_tokens_hash_uidx
  ON public_conversation_tokens (token_hash);
CREATE INDEX IF NOT EXISTS public_conversation_tokens_conversation_idx
  ON public_conversation_tokens (conversation_id, expires_at);

-- BF_SERVER_v789_CASL_EXPRESS_CONSENT - the exact consent wording a visitor
-- agreed to on a public website form, next to consent_basis / consent_at.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_text text;



-- ===== [C] crm, silo, tasks, slf notes, lender products =====

-- BF_SERVER_v789_SILO_SCOPING - crm_leads carry a silo (existing rows are BF) so
-- GET /api/crm/leads can filter by the caller's silo.
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS silo text;
UPDATE crm_leads SET silo = 'BF' WHERE silo IS NULL;
ALTER TABLE crm_leads ALTER COLUMN silo SET DEFAULT 'BF';
ALTER TABLE crm_leads ALTER COLUMN silo SET NOT NULL;
CREATE INDEX IF NOT EXISTS crm_leads_silo_created_idx ON crm_leads (silo, created_at DESC);

-- BF_SERVER_v789_TASKS_UNIFIED - copy any crm_tasks rows written since the
-- 2026_07_06 retirement (calendar + Maya kept writing there) into tasks.
-- Mapping: tasks.source = 'IMPORT' AND tasks.source_ref_id = crm_tasks.id (the
-- same key 2026_07_06_retire_crm_tasks.sql used), so already-copied rows are
-- skipped. Values are UPPERCASE per the tasks CHECKs. assignee_user_id is NOT
-- NULL: assigned_to, else owner_id, else the contact's owner; rows with none of
-- these (or pointing at a missing user) stay in crm_tasks. Dynamic SQL inside a
-- to_regclass guard so this file runs on a database without crm_tasks.
DO $$
BEGIN
  IF to_regclass('public.crm_tasks') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO tasks (
        id, silo, title, body, type, status, priority, due_at, reminder_at,
        assignee_user_id, contact_id, company_id, created_by, completed_at,
        source, source_ref_id, graph_id, created_at, updated_at
      )
      SELECT
        gen_random_uuid(),
        CASE upper(COALESCE(ct.silo, '')) WHEN 'BI' THEN 'BI' WHEN 'SLF' THEN 'SLF' ELSE 'BF' END,
        COALESCE(NULLIF(ct.title, ''), 'Task'),
        ct.notes,
        CASE upper(COALESCE(ct.task_type, 'TODO'))
          WHEN 'CALL' THEN 'CALL' WHEN 'EMAIL' THEN 'EMAIL' WHEN 'SMS' THEN 'SMS'
          ELSE 'TODO' END,
        CASE lower(COALESCE(ct.status, 'open'))
          WHEN 'done' THEN 'COMPLETED' WHEN 'completed' THEN 'COMPLETED'
          WHEN 'in_progress' THEN 'IN_PROGRESS' WHEN 'waiting' THEN 'WAITING'
          WHEN 'deferred' THEN 'DEFERRED' ELSE 'NOT_STARTED' END,
        CASE upper(COALESCE(ct.priority, 'NONE'))
          WHEN 'LOW' THEN 'LOW' WHEN 'MEDIUM' THEN 'MEDIUM' WHEN 'HIGH' THEN 'HIGH'
          ELSE 'NONE' END,
        ct.due_at,
        ct.reminder_at,
        u.id,
        c.id,
        co.id,
        cb.id,
        CASE WHEN lower(COALESCE(ct.status, '')) IN ('done', 'completed')
             THEN COALESCE(ct.completed_at, ct.updated_at) ELSE NULL END,
        'IMPORT',
        ct.id,
        ct.graph_id,
        ct.created_at,
        ct.updated_at
      FROM crm_tasks ct
      LEFT JOIN contacts c ON c.id = ct.contact_id
      LEFT JOIN companies co ON co.id = ct.company_id
      LEFT JOIN users cb ON cb.id = ct.owner_id
      JOIN users u ON u.id = COALESCE(ct.assigned_to, ct.owner_id, c.owner_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM tasks t WHERE t.source = 'IMPORT' AND t.source_ref_id = ct.id
      )
    $sql$;
  END IF;
END
$$;

-- BF_SERVER_v789_SLF_NOTES - notes on SLF applications (src/routes/slf.ts).
CREATE TABLE IF NOT EXISTS slf_application_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  body text NOT NULL,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS slf_application_notes_app_created_idx
  ON slf_application_notes (application_id, created_at DESC);



-- ===== [D] maya staff, marketing, analytics =====



-- ===== [E] service tokens, BI, o365, ssrf =====
-- BF_SERVER_v789_O365_OAUTH_STATE - single-use O365 connect nonces. Only the
-- SHA-256 of the nonce is stored; the browser holds the nonce in an HttpOnly
-- cookie and the OAuth state carries it. The callback consumes a row once.
CREATE TABLE IF NOT EXISTS o365_oauth_states (
  nonce_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_o365_oauth_states_expires_at ON o365_oauth_states (expires_at);


-- ===== [F] workers, migrations, seed =====

-- BF_SERVER_v789_SMS_CASCADE_ATTEMPTS - fallback_sent is now set only when the
-- fallback email was actually accepted. A failed send is counted here so a
-- permanently failing address stops being retried (and stops occupying the
-- worker's 20-row batch) after a few attempts.
ALTER TABLE sms_campaign_sends ADD COLUMN IF NOT EXISTS fallback_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE sms_campaign_sends ADD COLUMN IF NOT EXISTS fallback_error text;


-- ===== [G] misc =====
-- BF_SERVER_v789_LP_TYPE_SYNC - updates moved category but not type; realign the rows
-- that drifted. Both columns are text in the baseline (type NOT NULL, so skip NULL
-- categories). Re-running matches no rows.
UPDATE lender_products
   SET type = category::text
 WHERE category IS NOT NULL
   AND type::text IS DISTINCT FROM category::text;

-- ===== end =====
