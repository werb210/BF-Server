-- BF_SERVER_SBA_OWNER_IDENTITY_v104
-- Per-owner Form 413 responses are position-keyed; stamp the stable owner
-- identity so shifted shareholder positions cannot misattribute finances.
ALTER TABLE application_form_responses
  ADD COLUMN IF NOT EXISTS owner_fingerprint text;
