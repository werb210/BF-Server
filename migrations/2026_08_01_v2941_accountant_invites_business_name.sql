-- BF_SERVER_ACCOUNTANT_INVITE_SCOPE_v1
-- The wizard is local-first (bf-client saveStepProgress is a no-op), so at
-- Step 5 the server has never seen the business name the applicant typed at
-- Step 3 - applications.name is only written by the Step 6 submit handler.
-- Capture the name the client already holds so the invitation email and the
-- accountant's application picker can show it before submit.
ALTER TABLE accountant_invites ADD COLUMN IF NOT EXISTS business_name TEXT;
