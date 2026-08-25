-- BF_SERVER_SBA_STAGE2_FORMS_v87
-- The two SBA portal forms exist in bf-client but nothing renders them.
-- Stage2Page builds its list from /api/portal/lender-products/required-docs and
-- looks each document_type up in FORM_RENDERERS; a key with no requirement row
-- never appears, so Sba413Form and Sba1919Form are currently dead code.
--
-- Both are Stage 2 on purpose. Stage 1 is what an applicant supplies to get
-- matched; these are what SBA needs before a 7(a) package goes out. SBA's own
-- burden estimate is 90 minutes for 413 and 31 for 1919 - in front of a
-- first-time applicant that is an exit, not a form.
--
-- 912 deliberately has no row: Step 4 already asks everything it needs, per
-- owner. What remains for 912 is rendering the PDF, which is server work.

INSERT INTO document_types (key, label, category, sort_order) VALUES
  ('sba_form_413',  'SBA Form 413 - Personal Financial Statement', 'core', 100),
  ('sba_form_1919', 'SBA Form 1919 - Borrower Information',        'core', 101)
ON CONFLICT (key) DO NOTHING;

-- Attach both to every active SBA product. Written as a SELECT rather than
-- hardcoded product ids so a new SBA product picks them up when it is added,
-- and so this does not depend on ids that differ between environments.
INSERT INTO lender_product_requirements (lender_product_id, document_type, required, stage)
SELECT p.id, t.doc_type, true, 2
  FROM lender_products p
  CROSS JOIN (VALUES ('sba_form_413'), ('sba_form_1919')) AS t(doc_type)
 WHERE upper(COALESCE(p.type, '')) IN ('SBA', 'SBA_GOVERNMENT')
   AND COALESCE(p.active, true) = true
ON CONFLICT DO NOTHING;
