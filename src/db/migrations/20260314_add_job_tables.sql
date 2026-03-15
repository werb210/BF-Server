CREATE TABLE IF NOT EXISTS document_processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    last_retry_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_document_processing_application
        FOREIGN KEY(application_id)
        REFERENCES applications(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_processing_jobs_status
ON document_processing_jobs(status);

CREATE INDEX IF NOT EXISTS idx_document_processing_jobs_application
ON document_processing_jobs(application_id);

CREATE TABLE IF NOT EXISTS banking_analysis_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    last_retry_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_banking_analysis_application
        FOREIGN KEY(application_id)
        REFERENCES applications(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_banking_analysis_jobs_status
ON banking_analysis_jobs(status);

CREATE INDEX IF NOT EXISTS idx_banking_analysis_jobs_application
ON banking_analysis_jobs(application_id);

CREATE TABLE IF NOT EXISTS credit_summary_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    last_retry_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_credit_summary_application
        FOREIGN KEY(application_id)
        REFERENCES applications(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credit_summary_jobs_status
ON credit_summary_jobs(status);

CREATE INDEX IF NOT EXISTS idx_credit_summary_jobs_application
ON credit_summary_jobs(application_id);
