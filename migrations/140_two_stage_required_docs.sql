-- BF_SERVER_BLOCK_TWO_STAGE_v1
-- Two-stage required-documents foundation.

-- 1. Remove duplicate aging-report doc entries from any existing
--    lender_products.required_documents arrays. A/R and A/P stay.
UPDATE lender_products
   SET required_documents = (
     SELECT COALESCE(jsonb_agg(doc), '[]'::jsonb)
       FROM jsonb_array_elements(required_documents) doc
      WHERE doc->>'category' NOT IN (
        'Accounts receivable aging report',
        'Accounts payable aging report'
      )
   )
 WHERE required_documents IS NOT NULL
   AND required_documents @> '[{"category": "Accounts receivable aging report"}]'::jsonb
    OR required_documents @> '[{"category": "Accounts payable aging report"}]'::jsonb;

-- 2. Add stage column to lender_product_requirements (normalized
--    side table). 1 = upload at submit, 2 = post-submit mini-portal.
ALTER TABLE IF EXISTS lender_product_requirements
  ADD COLUMN IF NOT EXISTS stage SMALLINT NOT NULL DEFAULT 1
    CHECK (stage IN (1, 2));

CREATE INDEX IF NOT EXISTS idx_lender_product_requirements_stage
  ON lender_product_requirements (stage);

-- BF_SERVER_BLOCK_40_HOTFIX_v1
-- application_id is TEXT, not UUID. applications.id was migrated
-- from UUID to TEXT in migrations 107 + 110. No FK because no
-- other table in this codebase keeps one against applications.id
-- (communications_messages.application_id is the precedent --
-- migration 107 explicitly drops its FK and column type).
-- Server-layer route handlers enforce the relationship.
CREATE TABLE IF NOT EXISTS application_form_responses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  TEXT NOT NULL,
  doc_type        TEXT NOT NULL,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, doc_type)
);

CREATE INDEX IF NOT EXISTS idx_application_form_responses_app
  ON application_form_responses (application_id);
CREATE INDEX IF NOT EXISTS idx_application_form_responses_submitted
  ON application_form_responses (application_id) WHERE submitted_at IS NOT NULL;

-- 4. Add canonical entries for the two seeded form doc-types.
--    Idempotent INSERT. personal_net_worth_statement already exists
--    in the doc_types catalog as a label; we add the canonical
--    key here for completeness. debt_stack is new.
INSERT INTO document_types (key, label, category, sort_order) VALUES
  ('personal_net_worth_statement', 'Personal net worth statement', 'core', 90),
  ('debt_stack',                   'Debt stack',                   'core', 95)
ON CONFLICT (key) DO NOTHING;
