-- BF_SERVER_BLOCK_1_30C_BANKING_MIGRATION_TYPE_FIX
-- Originally written by Block 1.30. The first attempt declared
-- application_id as UUID, but applications.id is TEXT in this DB —
-- PostgreSQL refused to create the FK. All ID columns referencing
-- applications.id or documents.id are TEXT here. Local primary keys
-- stay UUID with gen_random_uuid().

CREATE TABLE IF NOT EXISTS banking_analyses (
  application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_avg_monthly_deposits NUMERIC(14,2),
  average_daily_balance NUMERIC(14,2),
  negative_balance_days INTEGER,
  total_deposits NUMERIC(14,2),
  total_withdrawals NUMERIC(14,2),
  average_monthly_nsfs NUMERIC(8,2),
  days_with_insufficient_funds INTEGER,
  months_profitable_numerator INTEGER,
  months_profitable_denominator INTEGER,
  current_month_net_cash_flow NUMERIC(14,2),
  unusual_transactions JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_vendors JSONB NOT NULL DEFAULT '[]'::jsonb,
  period_start DATE,
  period_end DATE,
  months_detected INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS banking_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  document_id TEXT,
  account_label TEXT,
  transaction_date DATE NOT NULL,
  description TEXT,
  amount NUMERIC(14,2) NOT NULL,
  balance_after NUMERIC(14,2),
  is_nsf BOOLEAN NOT NULL DEFAULT false,
  is_unusual BOOLEAN NOT NULL DEFAULT false,
  category TEXT,
  vendor TEXT,
  raw_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_banking_tx_app ON banking_transactions(application_id);
CREATE INDEX IF NOT EXISTS idx_banking_tx_date ON banking_transactions(application_id, transaction_date);

CREATE TABLE IF NOT EXISTS banking_monthly_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  month_start DATE NOT NULL,
  total_deposits NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_withdrawals NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_cash_flow NUMERIC(14,2) NOT NULL DEFAULT 0,
  ending_balance NUMERIC(14,2),
  nsf_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT banking_monthly_unique UNIQUE (application_id, month_start)
);
