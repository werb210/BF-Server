-- Only insert if tables are empty
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lenders LIMIT 1) THEN

    -- Lender 1: Boreal Capital
    INSERT INTO lenders (id, name, country, submission_method, active, created_at, updated_at)
    VALUES (
      '11111111-1111-1111-1111-111111111111',
      'Boreal Capital Partners', 'CA', 'email', true, now(), now()
    );

    -- Lender 2: Northern Business Finance
    INSERT INTO lenders (id, name, country, submission_method, active, created_at, updated_at)
    VALUES (
      '22222222-2222-2222-2222-222222222222',
      'Northern Business Finance', 'CA', 'email', true, now(), now()
    );

    -- Lender products for Boreal Capital
    INSERT INTO lender_products (id, lender_id, name, category, active, country, min_amount, max_amount, created_at, updated_at)
    VALUES
      ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111111', 'Business Line of Credit', 'LOC',       true, 'CA', 25000,  500000, now(), now()),
      ('33333333-3333-3333-3333-333333333302', '11111111-1111-1111-1111-111111111111', 'Term Loan',               'TERM',      true, 'CA', 50000,  1000000, now(), now()),
      ('33333333-3333-3333-3333-333333333303', '11111111-1111-1111-1111-111111111111', 'Equipment Financing',     'EQUIPMENT', true, 'CA', 10000,  500000, now(), now()),
      ('33333333-3333-3333-3333-333333333304', '11111111-1111-1111-1111-111111111111', 'Working Capital Loan',    'TERM',      true, 'CA', 10000,  250000, now(), now()),
      ('33333333-3333-3333-3333-333333333305', '11111111-1111-1111-1111-111111111111', 'Invoice Factoring',       'FACTORING', true, 'CA', 25000,  2000000, now(), now()),
      ('33333333-3333-3333-3333-333333333306', '11111111-1111-1111-1111-111111111111', 'Merchant Cash Advance',   'MCA',       true, 'CA', 5000,   200000, now(), now()),
      ('33333333-3333-3333-3333-333333333307', '11111111-1111-1111-1111-111111111111', 'PO Financing',            'PO',        true, 'CA', 25000,  1000000, now(), now());

    -- Lender products for Northern Business Finance
    INSERT INTO lender_products (id, lender_id, name, category, active, country, min_amount, max_amount, created_at, updated_at)
    VALUES
      ('44444444-4444-4444-4444-444444444401', '22222222-2222-2222-2222-222222222222', 'Revolving Credit Line',   'LOC',       true, 'CA', 50000,  750000, now(), now()),
      ('44444444-4444-4444-4444-444444444402', '22222222-2222-2222-2222-222222222222', 'Business Term Loan',      'TERM',      true, 'CA', 100000, 2000000, now(), now()),
      ('44444444-4444-4444-4444-444444444403', '22222222-2222-2222-2222-222222222222', 'AR Factoring',            'FACTORING', true, 'CA', 50000,  5000000, now(), now());

  END IF;
END $$;
