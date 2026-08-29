-- BF_SERVER_SBA_NO_BANK_STATEMENTS_v140
-- BF_SERVER_V140_MIGRATION_FIX_v143
--
-- The first version of this file opened with an unguarded
--   a DELETE against the document_requirements table.
-- No migration in this repo creates that table. clientDocumentsNeeded queries it
-- behind .catch(() => ({ rows: [] })) and falls through to the product JSON, so
-- its absence was invisible in the application. Migrations run at startup and
-- fail closed, so the server refused to boot.
--
-- The statement is removed rather than guarded. All four BF services share one
-- database and the boot failure proves the table is absent from it, so the
-- DELETE was operating on nothing. A plpgsql guard would add a construct the
-- test suite cannot execute in exchange for protecting a table that is not there.
--
-- If document_requirements is ever introduced, no cleanup is needed for SBA:
-- alwaysRequiredFor() stops bank statements being written for SBA products in
-- the first place, so there would be no rows to remove.
--
-- The product JSON below is the path that actually feeds the client today.
UPDATE lender_products
   SET required_documents = (
     SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
       FROM jsonb_array_elements(required_documents) AS e
      WHERE COALESCE(e->>'document_type', e->>'category') <> 'bank_statements_6_months'
   )
 WHERE upper(COALESCE(category, '')) = 'SBA'
   AND jsonb_typeof(required_documents) = 'array'
   AND required_documents::text LIKE '%bank_statements_6_months%';
