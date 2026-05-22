-- v613: prevent duplicate lender packages per (application_id, lender_id).
-- Dedupe any pre-existing duplicates first (keep oldest), then add uniqueness.
BEGIN;

DELETE FROM application_packages a
  USING application_packages b
 WHERE a.ctid < b.ctid
   AND a.application_id = b.application_id
   AND a.lender_id = b.lender_id;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_packages_app_lender
  ON application_packages(application_id, lender_id);

COMMIT;
