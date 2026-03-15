CREATE INDEX IF NOT EXISTS idx_document_processing_jobs_status
ON document_processing_jobs(status);

CREATE INDEX IF NOT EXISTS idx_document_processing_jobs_application
ON document_processing_jobs(application_id);

CREATE INDEX IF NOT EXISTS idx_banking_analysis_jobs_status
ON banking_analysis_jobs(status);

CREATE INDEX IF NOT EXISTS idx_banking_analysis_jobs_application
ON banking_analysis_jobs(application_id);

CREATE INDEX IF NOT EXISTS idx_credit_summary_jobs_status
ON credit_summary_jobs(status);

CREATE INDEX IF NOT EXISTS idx_credit_summary_jobs_application
ON credit_summary_jobs(application_id);
