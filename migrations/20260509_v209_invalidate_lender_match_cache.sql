-- BF_SERVER_BLOCK_v209_LENDER_CACHE_CLEAR_AND_OCR_VISIBLE_LOGGING_v1
-- BF_SERVER_BLOCK_v209a_FIX_BROKEN_MIGRATION_v1
-- Force every application's lender_matches cache to recompute on next view.
-- v206 added a productCategory filter to matchLenders, but apps with cached
-- match arrays from before v206 keep serving the pre-filter results from
-- the cache. Clearing the cache forces a fresh compute that uses the filter.
--
-- This migration runs exactly once (tracked by schema_migrations).
-- The previous version of this file referenced an incorrect timestamp column;
-- the correct column is 'lender_matches_computed_at'.

UPDATE applications
   SET lender_matches             = NULL,
       lender_matches_stale       = TRUE,
       lender_matches_computed_at = NULL
 WHERE lender_matches IS NOT NULL;
