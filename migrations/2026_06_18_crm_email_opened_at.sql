-- #48 — ensure the read-receipt column exists before the contact email feed selects it.
ALTER TABLE crm_email_log ADD COLUMN IF NOT EXISTS opened_at timestamptz;
