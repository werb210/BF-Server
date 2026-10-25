-- BF_SERVER_v855_RETENTION - enforced 7-year document retention and legal holds (Todd, Oct 24).
-- Idempotent: safe to run again. Same rules in every silo (BF, BI, SLF, KS); holds and the report are listed per silo.
--
-- When a file "closes" (see src/retention/policy.ts):
--   funded    funded_at is set, or pipeline_state is Accepted / Funded
--   declined  pipeline_state is Rejected / Declined
--   withdrawn pipeline_state is Withdrawn / Closed / Archived, or application_status is withdrawn / declined /
--             expired / completed
-- applications.closed_at is stamped by a trigger the moment a file first becomes closed, and cleared if it is
-- reopened (a later close stamps a later date, so the lock only ever gets longer).
-- A record is kept for 7 years from the later of its upload and the file's closing.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS closed_at timestamptz;

CREATE OR REPLACE FUNCTION ks_application_is_closed(p_pipeline_state text, p_application_status text, p_funded_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_funded_at IS NOT NULL
      OR lower(trim(COALESCE(p_pipeline_state, ''))) IN ('accepted', 'funded', 'rejected', 'declined', 'withdrawn', 'closed', 'archived')
      OR lower(trim(COALESCE(p_application_status, ''))) IN ('withdrawn', 'declined', 'expired', 'completed')
$$;

CREATE OR REPLACE FUNCTION ks_application_closed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ks_application_is_closed(NEW.pipeline_state, NEW.application_status, NEW.funded_at) THEN
    IF NEW.closed_at IS NULL THEN
      NEW.closed_at := now();
    END IF;
  ELSE
    NEW.closed_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ks_application_closed_at ON applications;
CREATE TRIGGER ks_application_closed_at
  BEFORE INSERT OR UPDATE OF pipeline_state, application_status, funded_at, closed_at ON applications
  FOR EACH ROW EXECUTE FUNCTION ks_application_closed_at();

-- Files already closed: the funding date, else the last stage move, else the last update.
UPDATE applications a
   SET closed_at = COALESCE(
         a.funded_at,
         (SELECT max(h.created_at) FROM application_stage_history h WHERE h.application_id::text = a.id::text),
         a.updated_at::timestamptz)
 WHERE a.closed_at IS NULL
   AND ks_application_is_closed(a.pipeline_state, a.application_status, a.funded_at);

-- Legal holds: an admin places one on an application, contact or company with a reason; it stays until released.
-- Rows are never deleted (released holds stay as the record of the hold).
CREATE TABLE IF NOT EXISTS legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('application', 'contact', 'company')),
  target_id text NOT NULL,
  target_label text,
  silo text NOT NULL DEFAULT 'BF',
  reason text NOT NULL,
  placed_by uuid,
  placed_by_name text,
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_by_name text,
  released_at timestamptz,
  release_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS legal_holds_one_active_idx ON legal_holds (target_type, target_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS legal_holds_target_idx ON legal_holds (target_type, target_id);

CREATE OR REPLACE FUNCTION ks_legal_holds_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'legal_holds rows are permanent; release a hold instead of deleting it';
END
$$;
DROP TRIGGER IF EXISTS ks_legal_holds_no_delete ON legal_holds;
CREATE TRIGGER ks_legal_holds_no_delete BEFORE DELETE ON legal_holds FOR EACH ROW EXECUTE FUNCTION ks_legal_holds_no_delete();

-- Audit events are kept for 7 years: a row younger than that cannot be deleted.
CREATE OR REPLACE FUNCTION ks_audit_events_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.created_at > now() - interval '7 years' THEN
    RAISE EXCEPTION 'retention_locked: audit events are kept for 7 years (this one until %)', (OLD.created_at + interval '7 years')::date;
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS ks_audit_events_retention ON audit_events;
CREATE TRIGGER ks_audit_events_retention BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION ks_audit_events_retention();

-- One row per application: whether it is a record, when it closed, when it can be deleted, and whether a hold covers it.
-- A draft that was never submitted or signed and has no documents or packages is not a record (nothing to keep).
-- retain_until is NULL while the file is open (locked until 7 years after it closes).
CREATE OR REPLACE VIEW retention_applications AS
SELECT a.id::text AS application_id,
       a.silo,
       COALESCE(NULLIF(a.business_legal_name, ''), NULLIF(a.name, ''), a.id::text) AS label,
       a.pipeline_state,
       a.created_at::timestamptz AS created_at,
       a.closed_at,
       d.last_upload_at,
       (a.submitted_at IS NOT NULL OR a.signnow_app_signed_at IS NOT NULL OR d.doc_count > 0
         OR EXISTS (SELECT 1 FROM application_packages p WHERE p.application_id::text = a.id::text)) AS is_record,
       CASE WHEN a.closed_at IS NULL THEN NULL
            ELSE GREATEST(a.created_at::timestamptz, COALESCE(d.last_upload_at, a.created_at::timestamptz), a.closed_at) + interval '7 years'
       END AS retain_until,
       EXISTS (
         SELECT 1 FROM legal_holds h
          WHERE h.released_at IS NULL
            AND (
              (h.target_type = 'application' AND h.target_id = a.id::text)
              OR (h.target_type = 'contact' AND (h.target_id = a.contact_id::text
                    OR EXISTS (SELECT 1 FROM application_contacts ac WHERE ac.application_id::text = a.id::text AND ac.contact_id::text = h.target_id)))
              OR (h.target_type = 'company' AND (h.target_id = a.company_id::text
                    OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = a.contact_id AND c.company_id::text = h.target_id)))
            )
       ) AS held
  FROM applications a
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS doc_count,
           GREATEST(max(COALESCE(x.uploaded_at, x.created_at::timestamptz)),
             (SELECT max(GREATEST(p.created_at, p.built_at)) FROM application_packages p
               WHERE p.application_id::text = a.id::text)) AS last_upload_at
      FROM documents x
     WHERE x.application_id::text = a.id::text
  ) d ON true;

-- One row per document (uploaded documents, signed agreements and generated forms all live in documents).
CREATE OR REPLACE VIEW retention_documents AS
SELECT x.id::text AS document_id,
       ra.application_id,
       ra.silo,
       COALESCE(NULLIF(x.display_name, ''), NULLIF(x.filename, ''), NULLIF(x.title, ''), x.document_type) AS label,
       ra.label AS application_label,
       COALESCE(x.uploaded_at, x.created_at::timestamptz) AS uploaded_at,
       ra.closed_at,
       CASE WHEN ra.closed_at IS NULL THEN NULL
            ELSE GREATEST(COALESCE(x.uploaded_at, x.created_at::timestamptz), ra.closed_at) + interval '7 years'
       END AS retain_until,
       ra.held
  FROM documents x
  JOIN retention_applications ra ON ra.application_id = x.application_id::text;
