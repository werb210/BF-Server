-- BF_SERVER_v865_BROKER_TOOLS_3_SALES_TAX - Canadian sales tax by province with an "as of" date (an Admin edits them in
-- Settings > Deal tools). A rate change is a new row, so an older quote keeps the rate of its day. Seeded with the rates
-- in force from 1 April 2025; re-running never overwrites an Admin's edit.
CREATE TABLE IF NOT EXISTS sales_tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  province text NOT NULL CHECK (province IN ('AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT')),
  effective_from date NOT NULL,
  gst numeric(6, 3) NOT NULL DEFAULT 0,
  pst numeric(6, 3) NOT NULL DEFAULT 0,
  hst numeric(6, 3) NOT NULL DEFAULT 0,
  qst numeric(6, 3) NOT NULL DEFAULT 0,
  note text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_tax_rates_province_day_uq ON sales_tax_rates (province, effective_from);

INSERT INTO sales_tax_rates (province, effective_from, gst, pst, hst, qst, note) VALUES
  ('AB', '2025-04-01', 5, 0, 0, 0, 'GST only'),
  ('BC', '2025-04-01', 5, 7, 0, 0, NULL),
  ('MB', '2025-04-01', 5, 7, 0, 0, 'Manitoba RST'),
  ('NB', '2025-04-01', 0, 0, 15, 0, NULL),
  ('NL', '2025-04-01', 0, 0, 15, 0, NULL),
  ('NS', '2025-04-01', 0, 0, 14, 0, 'HST 14% from 1 April 2025'),
  ('NT', '2025-04-01', 5, 0, 0, 0, 'GST only'),
  ('NU', '2025-04-01', 5, 0, 0, 0, 'GST only'),
  ('ON', '2025-04-01', 0, 0, 13, 0, NULL),
  ('PE', '2025-04-01', 0, 0, 15, 0, NULL),
  ('QC', '2025-04-01', 5, 0, 0, 9.975, NULL),
  ('SK', '2025-04-01', 5, 6, 0, 0, NULL),
  ('YT', '2025-04-01', 5, 0, 0, 0, 'GST only')
ON CONFLICT (province, effective_from) DO NOTHING;
