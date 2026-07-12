-- BF_SERVER_TEAMS_ORGANIZER_AAD_ID_v1
-- Graph rejects a UPN in the /users/{id}/onlineMeetings family when called with
-- APPLICATION permissions: "The userId in request URL is not a GUID." It wants
-- the organizer's Entra object id. (A UPN is fine for /users/{upn} and for
-- sendMail, which is why the submissions pipeline never hit this.) Cache the
-- resolved object id next to the UPN so we resolve it once per organizer.
--
-- Asserts its own column - see BF_SERVER_TEAMS_MEETINGS_BACKFILL_v2: the ledger
-- is keyed on FILENAME, so an earlier migration's ADD COLUMN lines may never
-- have run against this database.
ALTER TABLE teams_meetings
  ADD COLUMN IF NOT EXISTS organizer_aad_id TEXT;

-- Rows that burned retry attempts against the GUID bug deserve a clean run.
UPDATE teams_meetings
   SET transcript_attempts = 0,
       status = 'scheduled',
       updated_at = now()
 WHERE transcript_fetched_at IS NULL
   AND status IN ('scheduled', 'no_transcript');
