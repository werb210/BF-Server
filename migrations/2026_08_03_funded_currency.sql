-- BF_SERVER_FUNDED_CURRENCY_v6
-- funded_amount has been a bare number since 2026_07_08, summed directly by the
-- dashboard, commission and ad-conversion queries. Recording a USD deal without
-- a currency would silently overstate revenue, because every one of those
-- queries adds the raw figure.
--
-- CAD is the default and every existing row is CAD: nothing to date was entered
-- as anything else, so backfilling the default is correct rather than a guess.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS funded_currency TEXT NOT NULL DEFAULT 'CAD';

-- Reporting is in CAD. A single rate is wrong for accounting but right for a
-- sales dashboard, and it is explicit rather than hidden in five queries.
CREATE TABLE IF NOT EXISTS fx_rates (
  currency    TEXT PRIMARY KEY,
  to_cad      NUMERIC(12,6) NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO fx_rates (currency, to_cad) VALUES ('CAD', 1.000000)
  ON CONFLICT (currency) DO NOTHING;
INSERT INTO fx_rates (currency, to_cad) VALUES ('USD', 1.370000)
  ON CONFLICT (currency) DO NOTHING;
