
CREATE INDEX IF NOT EXISTS idx_documents_application
ON documents(application_id);

CREATE INDEX IF NOT EXISTS idx_documents_owner
ON documents(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_applications_owner
ON applications(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_ocr_results_application
ON ocr_results(application_id);

CREATE INDEX IF NOT EXISTS idx_ocr_results_status
ON ocr_results(status);

CREATE INDEX IF NOT EXISTS idx_lender_submissions_app
ON lender_submissions(application_id);

