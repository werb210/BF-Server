-- BF_SERVER_SBA_STAGE2_REACHABLE_v101
-- Mirror the SBA Stage 2 requirements into the product JSON read by the portal.
CREATE OR REPLACE FUNCTION sba_merge_stage2_into_product_json()
RETURNS TRIGGER AS $$
DECLARE
  wanted jsonb;
  have jsonb;
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
    {"document_type":"debt_schedule",        "required":false, "stage":2},
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

DROP TRIGGER IF EXISTS trg_sba_merge_stage2_json ON lender_products;
CREATE TRIGGER trg_sba_merge_stage2_json
  BEFORE INSERT OR UPDATE OF type ON lender_products
  FOR EACH ROW EXECUTE FUNCTION sba_merge_stage2_into_product_json();

UPDATE lender_products
SET type = type
WHERE upper(COALESCE(type,'')) IN ('SBA','SBA_GOVERNMENT')
  AND COALESCE(active, true) = true;
