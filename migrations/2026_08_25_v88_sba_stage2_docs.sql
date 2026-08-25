-- BF_SERVER_SBA_STAGE2_DOCS_v88
-- Everything an SBA 7(a) file needs after submission: the two portal forms, plus
-- the documents a lender asks for. All Stage 2 on purpose - Stage 1 is what gets
-- an applicant matched, and SBA's own burden estimate is 90 minutes for 413 and
-- 31 for 1919. In front of a first-time applicant that is an exit, not a form.
--
-- Stage2Page renders a form when document_type matches a key in FORM_RENDERERS
-- and falls through to a file upload otherwise, so the two sba_form_* keys become
-- forms and the rest become upload rows with no extra client work.
--
-- Start-ups are exempt from the Stage 1 set (bank statements, filed financials,
-- tax returns) because a business that has not traded has none of them. These are
-- different: a lender underwriting a start-up has no history to look at, so the
-- business plan and the owners' personal returns carry the file.

INSERT INTO document_types (key, label, category, sort_order) VALUES
  ('sba_form_413',        'SBA Form 413 - Personal Financial Statement',  'core', 100),
  ('sba_form_1919',       'SBA Form 1919 - Borrower Information',         'core', 101),
  ('owner_photo_id',      'Government photo ID - each 20%+ owner',        'core', 102),
  ('formation_documents', 'Articles of incorporation, operating agreement or DBA registration', 'core', 103),
  ('personal_tax_returns','Personal tax returns - last 3 years, each 20%+ owner', 'core', 104),
  ('business_plan',       'Business plan with financial projections',     'core', 105),
  ('sba_1919_attachments','Supporting detail for any Yes answer on Form 1919', 'core', 106),
  ('debt_schedule',       'Debt schedule - existing business debt',       'core', 107),
  ('lease_or_loi',        'Lease or letter of intent for premises',       'core', 108)
ON CONFLICT (key) DO NOTHING;

-- Attached to every active SBA product by SELECT rather than by hardcoded id, so
-- a new SBA product picks these up automatically and this does not depend on ids
-- that differ between environments.
--
-- Guarded with NOT EXISTS rather than ON CONFLICT: there is no unique index on
-- (lender_product_id, document_type), so ON CONFLICT would silently do nothing
-- and a re-run would insert duplicates. Migrations run on every boot.
INSERT INTO lender_product_requirements (lender_product_id, document_type, required, stage)
SELECT p.id, t.doc_type, t.is_required, 2
  FROM lender_products p
  CROSS JOIN (VALUES
      ('sba_form_413',         true),
      ('sba_form_1919',        true),
      ('owner_photo_id',       true),
      ('formation_documents',  true),
      ('personal_tax_returns', true),
      ('business_plan',        true),
      -- Conditional in practice: only needed if a 1919 answer was Yes, if there
      -- is debt to refinance, or if the loan touches premises. Marked optional so
      -- an applicant with none of those is not chasing a document that does not
      -- exist for them.
      ('sba_1919_attachments', false),
      ('debt_schedule',        false),
      ('lease_or_loi',         false)
    ) AS t(doc_type, is_required)
 WHERE upper(COALESCE(p.type, '')) IN ('SBA', 'SBA_GOVERNMENT')
   AND COALESCE(p.active, true) = true
   AND NOT EXISTS (
     SELECT 1 FROM lender_product_requirements r
      WHERE r.lender_product_id = p.id
        AND r.document_type = t.doc_type
   );
