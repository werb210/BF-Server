-- BF_SERVER_REFERRER_SELF_v1 - referrer-portal profile columns on users.
-- A referrer is a users row with role 'Referrer'. The portal lets them set
-- their company name and mark their profile complete. first_name / last_name /
-- email already exist (migrations 100 / 102 / 039); add the two that don't.
ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS profile_complete boolean NOT NULL DEFAULT false;
