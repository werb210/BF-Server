-- BF_SERVER_FLOW_SECOND_ADDRESS_v1 - a person who goes through the never-opened emails without opening one, and who has a
-- second email address on file, gets the flow again at that address. round = 1 (first address) or 2 (second address);
-- prior_keys = the emails already sent to the first address (kept for the flow's counts).
ALTER TABLE crm_flow_members ADD COLUMN IF NOT EXISTS round integer NOT NULL DEFAULT 1;
ALTER TABLE crm_flow_members ADD COLUMN IF NOT EXISTS prior_keys text[] NOT NULL DEFAULT ARRAY[]::text[];
