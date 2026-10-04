-- BF_SERVER_MATCH_REFRESH_v732 - one-time: lender lists on open files were computed before
-- lenders like Bondit Media were added. Mark them out of date so each recalculates the next
-- time its Lenders tab opens.
UPDATE applications SET lender_matches_stale = true
 WHERE pipeline_state IN ('Received','In Review','Documents Required','Additional Steps Required','Off to Lender','Offer')
   AND lender_matches_computed_at IS NOT NULL
   AND COALESCE(lender_matches_stale, false) = false;
