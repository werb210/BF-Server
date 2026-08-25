-- BF_SERVER_SBA_DOCS_AUTO_ATTACH_v99
-- v88 attached the SBA Stage 2 forms and uploads with a one-time INSERT, so it
-- only covered the SBA products that existed the moment it ran. Any SBA product
-- added later - a real SBA lender, for instance - would have an EMPTY Stage 2
-- list, and its applicants would be asked for nothing at all.
--
-- A trigger instead of a one-off: whenever a product is created or changed to
-- type SBA, it gets the full requirement set. Migrations run on every boot, so
-- the backfill below also catches anything created between v88 and this.

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
        -- Conditional in practice: only needed on a Yes answer, existing debt,
        -- or premises. Optional so an applicant with none of those is not
        -- chasing a document that does not exist for them.
        ('sba_1919_attachments', false),
        ('debt_schedule',        false),
        ('lease_or_loi',         false)
      ) AS t(doc_type, is_required)
   WHERE NOT EXISTS (
     SELECT 1 FROM lender_product_requirements r
      WHERE r.lender_product_id = NEW.id AND r.document_type = t.doc_type
   );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sba_attach_stage2 ON lender_products;
CREATE TRIGGER trg_sba_attach_stage2
  AFTER INSERT OR UPDATE OF type ON lender_products
  FOR EACH ROW EXECUTE FUNCTION sba_attach_stage2_requirements();

-- Backfill anything already there without the full set.
INSERT INTO lender_product_requirements (lender_product_id, document_type, required, stage)
SELECT p.id, t.doc_type, t.is_required, 2
  FROM lender_products p
  CROSS JOIN (VALUES
      ('sba_form_413', true), ('sba_form_1919', true), ('owner_photo_id', true),
      ('formation_documents', true), ('personal_tax_returns', true), ('business_plan', true),
      ('sba_1919_attachments', false), ('debt_schedule', false), ('lease_or_loi', false)
    ) AS t(doc_type, is_required)
 WHERE upper(COALESCE(p.type,'')) IN ('SBA','SBA_GOVERNMENT')
   AND COALESCE(p.active, true) = true
   AND NOT EXISTS (
     SELECT 1 FROM lender_product_requirements r
      WHERE r.lender_product_id = p.id AND r.document_type = t.doc_type
   );
