-- BF_SERVER_SBA_NO_BANK_STATEMENTS_v140
-- Applications already sitting at Documents Required are blocked on a document
-- SBA does not want. The code change above stops it being added to NEW files;
-- this clears it from the ones already stuck.
--
-- Scoped to SBA products only, and only where the document has not actually
-- been uploaded - if an applicant already sent statements we keep the row so
-- the upload still has something to match against.
DELETE FROM document_requirements dr
 USING applications a
  JOIN lender_products lp ON lp.id::text = a.lender_product_id::text
 WHERE dr.application_id::text = a.id::text
   AND upper(COALESCE(lp.category, '')) = 'SBA'
   AND dr.category = 'bank_statements_6_months'
   AND NOT EXISTS (
     SELECT 1 FROM documents d
      WHERE d.application_id::text = a.id::text
        AND d.category = 'bank_statements_6_months'
   );

-- Same for the product JSON, so the fallback path does not put it back.
UPDATE lender_products
   SET required_documents = (
     SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
       FROM jsonb_array_elements(required_documents) AS e
      WHERE COALESCE(e->>'document_type', e->>'category') <> 'bank_statements_6_months'
   )
 WHERE upper(COALESCE(category, '')) = 'SBA'
   AND jsonb_typeof(required_documents) = 'array'
   AND required_documents::text LIKE '%bank_statements_6_months%';
