-- BF_SERVER_v956_CONDITION_CLIENT_WORDING - a funding condition keeps the lender's wording (title, description) for
-- staff, and may carry the same requirement in plain words for the client. The client app shows the plain wording when
-- there is one. Safe to run again.
ALTER TABLE funding_conditions ADD COLUMN IF NOT EXISTS client_title text;
