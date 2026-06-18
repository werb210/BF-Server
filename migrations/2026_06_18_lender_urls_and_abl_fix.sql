-- BF_SERVER_BLOCK_vA — idempotent. Repo-sync of columns already added live on
-- boreal-pg01-recovery, plus correction of asset-based products mislabeled LOC.

ALTER TABLE lenders ADD COLUMN IF NOT EXISTS application_url TEXT;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS announcement   TEXT;

-- ABL and LOC are separate categories. These asset-based products were seeded
-- as category/type='LOC' and must be 'ABL'. Name-guarded; safe to re-run.
UPDATE lender_products
   SET category = 'ABL', type = 'ABL'
 WHERE category <> 'ABL'
   AND name IN (
     'Asset-Based Lending',
     'Structured / ABL Finance'
   )
   AND lender_id IN (
     SELECT id FROM lenders
      WHERE name IN ('Accord','Capitally','Knightsbridge','Pathward','Travelers')
   );
