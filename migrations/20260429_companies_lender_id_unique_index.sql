-- BF_LENDER_MIRROR_FIX_v52 — add a PARTIAL unique index on companies.lender_id
-- so the lenderCrmMirror upsert can use ON CONFLICT (lender_id) ... .
-- Idempotent: deduplicates pre-existing non-null lender_id collisions by
-- NULLing out the duplicates (oldest row keeps the link). This is safe in V1
-- because the dual-write will re-establish the link on the next mirror call.

DO $mig$
BEGIN
  -- Step 1: deduplicate any rows that would block the unique index.
  -- Keep the oldest row per lender_id; NULL the others.
  WITH ranked AS (
    SELECT id,
           lender_id,
           ROW_NUMBER() OVER (
             PARTITION BY lender_id
             ORDER BY created_at ASC NULLS LAST, id ASC
           ) AS rn
      FROM companies
     WHERE lender_id IS NOT NULL
  )
  UPDATE companies c
     SET lender_id = NULL,
         updated_at = now()
    FROM ranked r
   WHERE c.id = r.id
     AND r.rn > 1;
END
$mig$;

-- Step 2: partial unique index. NULLs are allowed many times (non-lender
-- companies), but each non-null lender_id may appear at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_lender_id_not_null
  ON companies (lender_id)
  WHERE lender_id IS NOT NULL;
