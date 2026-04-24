-- 112_document_types.sql
-- Configurable document types table — admins manage via Settings, no code deploy needed.

CREATE TABLE IF NOT EXISTS document_types (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text        NOT NULL UNIQUE,
  label       text        NOT NULL,
  category    text        NOT NULL DEFAULT 'core',
  sort_order  integer     NOT NULL DEFAULT 0,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_types_category ON document_types(category);
CREATE INDEX IF NOT EXISTS idx_document_types_active ON document_types(active);

-- Seed V1 document types
INSERT INTO document_types (key, label, category, sort_order) VALUES
  -- Always required (locked)
  ('six_month_bank_statements', '6 months business banking statements', 'always', 0),
  -- Core underwriting pack
  ('three_year_financials',    '3 years accountant prepared financials', 'core', 10),
  ('three_year_tax_returns',   '3 years business tax returns',           'core', 20),
  ('pnl_interim',              'PnL – Interim financials',               'core', 30),
  ('balance_sheet_interim',    'Balance Sheet – Interim financials',     'core', 40),
  ('ar',                       'A/R',                                    'core', 50),
  ('ap',                       'A/P',                                    'core', 60),
  ('government_id',            '2 pieces of Government Issued ID',       'core', 70),
  ('void_cheque',              'VOID cheque or PAD',                     'core', 80),
  -- Equipment / Asset Financing
  ('purchase_order',           'Purchase Order (PO)',                    'equipment', 10),
  ('invoice',                  'Invoice',                                'equipment', 20),
  ('equipment_details',        'Equipment details / quote',              'equipment', 30),
  -- Factoring / A/R Financing
  ('customer_list',            'Customer list',                          'factoring', 10),
  ('sample_invoices',          'Sample invoices',                        'factoring', 20),
  ('customer_contracts',       'Contract(s) with customers',             'factoring', 30),
  -- Media / Film Financing
  ('media_budget',             'Budget',                                 'media', 10),
  ('finance_plan',             'Finance plan',                           'media', 20),
  ('tax_credit_status',        'Tax credit status (applying / approved / certified)', 'media', 30),
  ('production_schedule',      'Production schedule',                    'media', 40),
  ('minimum_guarantees',       'Minimum guarantees / presales (if any)', 'media', 50)
ON CONFLICT (key) DO NOTHING;

-- Fix lender_products.type NOT NULL — mirror from category
-- Migration 034 set type NOT NULL but createLenderProduct never inserted it
UPDATE lender_products
SET type = COALESCE(type, category, 'LOC')
WHERE type IS NULL OR type = '';
