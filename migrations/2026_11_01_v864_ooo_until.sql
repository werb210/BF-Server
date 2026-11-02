-- BF_SERVER_v864_OOO_UNTIL - Boreal's own out-of-office window, set with the Microsoft 365 automatic replies in
-- Settings > My Profile. While now() is inside it the presence recompute marks the user busy and inbound calls do not
-- ring them; at out_of_office_until it ends by itself. 'infinity' = on with no end date. Safe to run more than once.
ALTER TABLE staff_presence ADD COLUMN IF NOT EXISTS out_of_office_from timestamptz;
ALTER TABLE staff_presence ADD COLUMN IF NOT EXISTS out_of_office_until timestamptz;
