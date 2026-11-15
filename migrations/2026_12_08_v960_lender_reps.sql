-- BF_SERVER_v960_LENDER_REPS - the person at the lender who is handling a submitted file.
-- Once a lender replies, staff record who is dealing with the file (name, position, email, direct phone). From then on
-- everything sent to that lender for that file (the package again, the signed term sheet, the lender question form,
-- further items) goes to that person only. Reps are kept under the lender so they can be picked again on the next file.
-- Safe to run again.
CREATE TABLE IF NOT EXISTS lender_reps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_id uuid NOT NULL,
  name text NOT NULL,
  position text,
  email text NOT NULL,
  phone text,
  contact_id uuid,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lender_reps_lender_email_uidx ON lender_reps (lender_id, lower(email));

CREATE TABLE IF NOT EXISTS application_lender_reps (
  application_id text NOT NULL,
  lender_id uuid NOT NULL,
  lender_rep_id uuid NOT NULL REFERENCES lender_reps(id) ON DELETE CASCADE,
  set_by text,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, lender_id)
);
