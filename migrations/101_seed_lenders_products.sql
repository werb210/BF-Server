-- 101_seed_lenders_products.sql (rewritten to match current schema after 041).
-- amount_min / amount_max are re-added in 121 and backfilled there.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lenders LIMIT 1) THEN
    INSERT INTO lenders (id, name, country, submission_method, active, created_at, updated_at)
    VALUES
      ('11111111-1111-1111-1111-111111111111', 'Boreal Capital Partners', 'CA', 'EMAIL', true, now(), now()),
      ('22222222-2222-2222-2222-222222222222', 'Northern Business Finance', 'CA', 'EMAIL', true, now(), now())
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO lender_products (id, lender_id, name, category, active, country, created_at, updated_at)
    VALUES
      ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111111', 'Business Line of Credit', 'LOC',       true, 'CA', now(), now()),
      ('33333333-3333-3333-3333-333333333302', '11111111-1111-1111-1111-111111111111', 'Term Loan',               'TERM',      true, 'CA', now(), now()),
      ('33333333-3333-3333-3333-333333333303', '11111111-1111-1111-1111-111111111111', 'Equipment Financing',     'EQUIPMENT', true, 'CA', now(), now()),
      ('33333333-3333-3333-3333-333333333304', '11111111-1111-1111-1111-111111111111', 'Working Capital Loan',    'TERM',      true, 'CA', now(), now()),
      ('33333333-3333-3333-3333-333333333305', '11111111-1111-1111-1111-111111111111', 'Invoice Factoring',       'FACTORING', true, 'CA', now(), now()),
      ('33333333-3333-3333-3333-333333333306', '11111111-1111-1111-1111-111111111111', 'Merchant Cash Advance',   'MCA',       true, 'CA', now(), now()),
      ('33333333-3333-3333-3333-333333333307', '11111111-1111-1111-1111-111111111111', 'PO Financing',            'PO',        true, 'CA', now(), now()),
      ('44444444-4444-4444-4444-444444444401', '22222222-2222-2222-2222-222222222222', 'Revolving Credit Line',   'LOC',       true, 'CA', now(), now()),
      ('44444444-4444-4444-4444-444444444402', '22222222-2222-2222-2222-222222222222', 'Business Term Loan',      'TERM',      true, 'CA', now(), now()),
      ('44444444-4444-4444-4444-444444444403', '22222222-2222-2222-2222-222222222222', 'AR Factoring',            'FACTORING', true, 'CA', now(), now())
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
