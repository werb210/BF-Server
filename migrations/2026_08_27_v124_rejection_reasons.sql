-- BF_SERVER_REJECTION_REASONS_v124
-- Catalogue lives in a table, not in code, so the applicant-facing copy can be
-- edited without a deploy. what_helps is nullable on purpose: some reasons
-- have no action the applicant can take.
CREATE TABLE IF NOT EXISTS rejection_reasons (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  why_it_matters TEXT NOT NULL DEFAULT '',
  what_helps TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS application_rejection_reasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id TEXT NOT NULL,
  lender_id TEXT,
  reason_code TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arr_app ON application_rejection_reasons (application_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_arr_unique
  ON application_rejection_reasons (application_id, COALESCE(lender_id, ''), reason_code);

ALTER TABLE applications ADD COLUMN IF NOT EXISTS rejection_email_sent_at TIMESTAMPTZ;

INSERT INTO rejection_reasons (code, label, why_it_matters, what_helps, sort_order) VALUES
('credit_score','Personal credit score below lender minimums','A personal guarantee puts your own credit on the line, so lenders weigh it heavily.','Bring revolving balances under 30% of their limits - usually the fastest single move. Pull your reports from Equifax and TransUnion (free once a year each) and dispute anything reported in error. Avoid new credit applications in the meantime, since each one costs you a few points.',10),
('bankruptcy','Recent bankruptcy or consumer proposal','Most lenders require a set number of years discharged before they will consider a file.','Time is the main factor. Rebuilding with a secured card or small installment loan, paid perfectly, shortens the wait at the lenders who do look at post-discharge files.',20),
('judgments_liens','Open judgments or liens','An unsatisfied judgment sits ahead of a new lender in priority, so it blocks most approvals.','Satisfy or settle the judgment and obtain written discharge. Once registered as discharged, send us the paperwork and we can look again.',30),
('revenue_threshold','Annual revenue below the threshold for the amount requested','Lenders size facilities against revenue; the request was large relative to trailing twelve months.','Either grow revenue, or come back with a smaller request. A clean repayment record on a smaller facility makes the larger amount considerably easier later.',40),
('dscr','Debt service coverage insufficient','After existing obligations, there was not enough left to comfortably service a new payment.','Pay down or consolidate existing debt, or reduce the amount requested so the payment fits.',50),
('cash_flow','Negative or declining cash flow','Bank statements showed cash going out faster than it came in over the review period.','Three to six months of consistent positive balances changes this materially. Tightening receivables collection is usually where it starts.',60),
('nsf','NSF activity in bank statements','Returned items signal that the account cannot reliably cover scheduled payments.','Six months with no NSF activity resolves this at most lenders. A small operating buffer prevents the timing misses that cause them.',70),
('time_in_business','Under minimum time in business','Most term products require two years of operating history.','This one is only solved by time. At 24 months a considerably wider set of lenders opens up. Equipment financing and invoice factoring sometimes go earlier - ask us and we will tell you honestly whether it is worth applying.',80),
('industry','Restricted or ineligible industry','Some sectors sit outside lender credit policy regardless of how strong the file is.','This is a policy limit rather than a reflection of your business. Specialist lenders exist for many restricted sectors and we can point you toward them.',90),
('documentation','Insufficient or unverifiable documentation','Lenders could not verify the figures from what was provided.','Complete filed financial statements, full bank statements for the period requested, and matching tax filings. We will tell you exactly which items were short if you reply.',100),
('debt_load','Existing debt load too high','Total outstanding obligations left no room for additional borrowing.','Consolidating higher-cost facilities, or clearing the smallest balances entirely, frees the most room.',110),
('collateral','Collateral insufficient for amount requested','The security offered did not cover the facility at the advance rates lenders apply.','Additional or higher-quality collateral, or a smaller request against the same security, both work.',120),
('structure','Ownership or guarantor structure not eligible','The ownership or guarantee arrangement did not meet lender requirements.','Reply and we will walk through what structure would be acceptable - this is often solvable on paper.',130)
ON CONFLICT (code) DO NOTHING;
