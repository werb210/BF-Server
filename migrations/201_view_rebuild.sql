-- Drop dependent views before altering
DROP VIEW IF EXISTS processing_job_history_view CASCADE;

-- Recreate AFTER schema changes
CREATE VIEW processing_job_history_view AS
SELECT *
FROM processing_jobs;
