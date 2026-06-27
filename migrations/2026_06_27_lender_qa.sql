-- BF_SERVER_LENDER_QA_v1
-- Staff <-> client lender question/answer round-trips.
-- application_id is TEXT (applications.id is TEXT since migrations 107/110);
-- no FK, matching application_form_responses (140_two_stage_required_docs.sql).
CREATE TABLE IF NOT EXISTS qa_sets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  silo          text NOT NULL DEFAULT 'BF',
  round         integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'draft',
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finalized_at  timestamptz
);

CREATE TABLE IF NOT EXISTS qa_questions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id             uuid NOT NULL,
  position           integer NOT NULL DEFAULT 1,
  prompt             text NOT NULL DEFAULT '',
  request_document   boolean NOT NULL DEFAULT false,
  answer_text        text,
  answer_document_id text,
  review_status      text NOT NULL DEFAULT 'draft',
  reject_reason      text,
  answered_at        timestamptz,
  reviewed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_sets_application ON qa_sets (application_id);
CREATE INDEX IF NOT EXISTS idx_qa_questions_set ON qa_questions (set_id);
