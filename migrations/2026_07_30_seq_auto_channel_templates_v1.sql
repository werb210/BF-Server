-- BF_SERVER_SEQ_AUTO_TEMPLATES_v1
-- An "auto" step (SMS to contacts you may lawfully text, email to everyone
-- else) had ONE template_id serving both branches. Whichever template you
-- picked was wrong for one of them: choose an email template and the SMS branch
-- texts raw HTML; choose an SMS template and the email branch sends a
-- subject-less one-liner. There was no correct choice.
--
-- An auto step now carries a template per channel. template_id stays for
-- single-channel steps (email / sms / task), which are unaffected.
ALTER TABLE marketing_sequence_steps ADD COLUMN IF NOT EXISTS sms_template_id UUID;
ALTER TABLE marketing_sequence_steps ADD COLUMN IF NOT EXISTS email_template_id UUID;
