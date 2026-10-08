-- BF_SERVER_REPORTS6_10_v780 - monthly funding and commission targets per staff member (Goals report).
CREATE TABLE IF NOT EXISTS report_goals (
  user_id           uuid NOT NULL,
  month             date NOT NULL,
  funding_target    numeric,
  commission_target numeric,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);
