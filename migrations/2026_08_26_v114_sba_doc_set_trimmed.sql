-- BF_SERVER_SBA_DOC_SET_v114
-- Remove documents that do not belong in SBA Stage 2 from both requirement stores.
DELETE FROM lender_product_requirements r
 USING lender_products p
 WHERE r.lender_product_id = p.id
   AND upper(COALESCE(p.type,'')) IN ('SBA','SBA_GOVERNMENT')
   AND r.document_type IN ('debt_schedule', 'six_month_bank_statements',
                           'business_banking_statements_6_months');

UPDATE lender_products
   SET required_documents = (
     SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
       FROM jsonb_array_elements(COALESCE(required_documents,'[]'::jsonb)) AS e
      WHERE COALESCE(e->>'document_type', e->>'category') NOT IN
            ('debt_schedule', 'six_month_bank_statements',
             'business_banking_statements_6_months')
   )
 WHERE upper(COALESCE(type,'')) IN ('SBA','SBA_GOVERNMENT')
   AND jsonb_typeof(COALESCE(required_documents,'[]'::jsonb)) = 'array';

-- A lease or LOI is conditional on the loan involving premises.
UPDATE lender_product_requirements r
   SET required = false
  FROM lender_products p
 WHERE r.lender_product_id = p.id
   AND upper(COALESCE(p.type,'')) IN ('SBA','SBA_GOVERNMENT')
   AND r.document_type = 'lease_or_loi';

UPDATE lender_products
   SET required_documents = (
     SELECT COALESCE(jsonb_agg(
              CASE WHEN COALESCE(e->>'document_type', e->>'category') = 'lease_or_loi'
                   THEN jsonb_set(e, '{required}', 'false'::jsonb)
                   ELSE e END
            ), '[]'::jsonb)
       FROM jsonb_array_elements(COALESCE(required_documents,'[]'::jsonb)) AS e
   )
 WHERE upper(COALESCE(type,'')) IN ('SBA','SBA_GOVERNMENT')
   AND jsonb_typeof(COALESCE(required_documents,'[]'::jsonb)) = 'array';

-- Rewrite the v99/v103 trigger functions so later product edits preserve the trim.
CREATE OR REPLACE FUNCTION sba_attach_stage2_requirements()
RETURNS TRIGGER AS $$
BEGIN
  IF upper(COALESCE(NEW.type,'')) NOT IN ('SBA','SBA_GOVERNMENT') THEN
    RETURN NEW;
  END IF;

  INSERT INTO lender_product_requirements (lender_product_id, document_type, required, stage)
  SELECT NEW.id, t.doc_type, t.is_required, 2
    FROM (VALUES
        ('sba_form_413',         true),
        ('sba_form_1919',        true),
        ('owner_photo_id',       true),
        ('formation_documents',  true),
        ('personal_tax_returns', true),
        ('business_plan',        true),
        ('sba_1919_attachments', false),
        ('lease_or_loi',         false)
      ) AS t(doc_type, is_required)
   WHERE NOT EXISTS (
     SELECT 1 FROM lender_product_requirements r
      WHERE r.lender_product_id = NEW.id AND r.document_type = t.doc_type
   );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sba_merge_stage2_into_product_json()
RETURNS TRIGGER AS $$
DECLARE
  wanted jsonb;
  have   jsonb;
BEGIN
  IF upper(COALESCE(NEW.type,'')) NOT IN ('SBA','SBA_GOVERNMENT') THEN
    RETURN NEW;
  END IF;

  wanted := '[
    {"document_type":"sba_form_413",         "required":true,  "stage":2},
    {"document_type":"sba_form_1919",        "required":true,  "stage":2},
    {"document_type":"owner_photo_id",       "required":true,  "stage":2},
    {"document_type":"formation_documents",  "required":true,  "stage":2},
    {"document_type":"personal_tax_returns", "required":true,  "stage":2},
    {"document_type":"business_plan",        "required":true,  "stage":2},
    {"document_type":"sba_1919_attachments", "required":false, "stage":2},
    {"document_type":"lease_or_loi",         "required":false, "stage":2}
  ]'::jsonb;

  have := CASE
            WHEN jsonb_typeof(COALESCE(NEW.required_documents,'[]'::jsonb)) = 'array'
              THEN NEW.required_documents
            ELSE '[]'::jsonb
          END;

  NEW.required_documents := have || (
    SELECT COALESCE(jsonb_agg(w), '[]'::jsonb)
      FROM jsonb_array_elements(wanted) AS w
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(have) AS h
        WHERE COALESCE(h->>'document_type', h->>'category') = w->>'document_type'
     )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
