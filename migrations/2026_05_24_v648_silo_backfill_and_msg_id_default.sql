-- BF_SERVER_BLOCK_v649_SHOWSTOPPER_PATCHES_v1 — migration v648
UPDATE lenders
   SET silo = 'BF', updated_at = NOW()
 WHERE silo IS NULL
   AND name IN (
     'Accord',
     'Accord Financial Corp.',
     'Baker Garrington Capital',
     'Brookridge Funding LLV',
     'Dynamic Capital Equipment Finance',
     'Meridian OneCap Credit Corp.',
     'Mobilization Funding',
     'Pathward',
     'Pearl Capital Final',
     'Quantum LS',
     'Revenued',
     'Stride Capital Corp.'
   );

UPDATE lender_products
   SET silo = 'BF', updated_at = NOW()
 WHERE silo IS NULL
   AND lender_id IN (
     SELECT id FROM lenders
     WHERE name IN (
       'Accord',
       'Accord Financial Corp.',
       'Baker Garrington Capital',
       'Brookridge Funding LLV',
       'Dynamic Capital Equipment Finance',
       'Meridian OneCap Credit Corp.',
       'Mobilization Funding',
       'Pathward',
       'Pearl Capital Final',
       'Quantum LS',
       'Revenued',
       'Stride Capital Corp.'
     )
   );

