-- BF_SERVER_v947_PORTER_CAPITAL - adds Porter Capital and its products (Todd, Nov 12 2026: "we never added these guys").
-- Figures are from Porter Capital's own website (portercap.com), the ABL Advisor directory and a Fortunly review, read
-- Nov 12 2026. Idempotent: nothing is inserted twice, and rows staff have since edited are left alone.
--
-- What is NOT known and is said so in the notes: whether they fund Canadian companies (their material says
-- "North America" and "nationwide", every example is US), minimum time in business or revenue, and contract length.

INSERT INTO lenders (id, name, country, active, status, submission_method, silo, website, webpage, phone, main_phone,
                     street, city, region, postal_code, street_address, city_state_zip,
                     contact_name, contact_phone, primary_contact_name, primary_contact_phone,
                     description, internal_notes, has_broker_agreement, created_at, updated_at)
SELECT gen_random_uuid(), 'Porter Capital', 'US', TRUE, 'ACTIVE', 'EMAIL', 'BF', 'https://portercap.com', 'https://portercap.com',
       '800-737-7344', '800-737-7344',
       '2112 1st Ave N', 'Birmingham', 'AL', '35203', '2112 1st Ave N', 'Birmingham, AL 35203',
       'John Cox Miller (SVP, National Sales Manager)', '205-397-4078', 'John Cox Miller (SVP, National Sales Manager)', '205-397-4078',
       'Direct lender and factor in Birmingham, Alabama, in business since 1991. Invoice factoring (recourse and non-recourse), accounts receivable lines, asset-based lending, freight factoring through Porter Freight Funding, purchase order financing and short bridge loans. Facilities from $25,000 to $25 million. No minimum credit score; works with start-ups that already have customers, turnarounds and companies in or after bankruptcy.',
       'Added Nov 12 2026 from public sources; nothing here was confirmed with Porter Capital. TO CONFIRM BEFORE SENDING A FILE: (1) whether they fund Canadian companies - their site says "North America" and "nationwide" but only US deals are shown, so the products are set to US only; (2) the submission email address - none is published, their site uses a contact form; (3) a broker agreement - their partner page offers referral partners a 15% commission after a referred business is funded (https://portercap.com/partner); (4) minimum time in business, minimum monthly sales and contract length - not published. Industries they name: staffing, manufacturing, distribution, service companies, construction, oil and gas, trucking and freight, technology, government contractors.',
       FALSE, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM lenders WHERE lower(name) = 'porter capital');

INSERT INTO lender_products
  (id, lender_id, lender_name, name, category, type, category_label, country, silo, active, status,
   min_amount, max_amount, amount_min, amount_max,
   rate_kind, rate_min_num, rate_max_num, interest_min, interest_max, min_rate, max_rate,
   term_min, term_max, term_unit, description, eligibility_notes, documents_required, required_documents, created_at, updated_at)
SELECT gen_random_uuid()::text, l.id, 'Porter Capital', p.name, p.category, p.category, p.category_label, 'US', 'BF', TRUE, 'active',
       p.amount_min, p.amount_max, p.amount_min, p.amount_max,
       p.rate_kind, p.rate_min, p.rate_max, p.rate_min::text, p.rate_max::text, p.rate_min::text, p.rate_max::text,
       p.term_min, p.term_max, 'MONTHS', p.description, p.eligibility, p.documents, '[]'::jsonb, NOW(), NOW()
FROM (SELECT id FROM lenders WHERE lower(name) = 'porter capital' ORDER BY created_at LIMIT 1) l
CROSS JOIN (VALUES
  ('Invoice Factoring', 'FACTORING', 'Invoice Factoring', 25000, 25000000, 'monthly', 0.4::numeric, 5.0::numeric, NULL::int, NULL::int,
   'Sells its unpaid business invoices for cash: up to 90% of each invoice within about 24 hours, the rest (less the fee) when the customer pays. Recourse and non-recourse. No concentration limits; past-due invoices considered.',
   'Business-to-business invoices on net 30 to net 120 terms, typically under 90 days old. No minimum credit score; approval rests on the customers'' credit. Start-ups with paying customers accepted. Fee is per invoice (advertised from 0.4%, usually 0.5% to 5%), not an annual rate. Minimum sales, time in business and contract length are not published.',
   'Accounts receivable aging; Customer list; Sample invoices; Financial statements; Articles of Incorporation'),
  ('Accounts Receivable Line of Credit', 'LOC', 'Business Line of Credit', 25000, 25000000, 'monthly', 1.0::numeric, 2.0::numeric, 12, 60,
   'A revolving line secured by receivables: borrows 70% to 90% of qualified receivables, up to $25 million. The business keeps collecting from its own customers.',
   'Requires financial statements, a receivables aging and creditworthy customers; higher monthly sales improve terms. The published cost is a collateral management fee of 1% to 2% of the amount outstanding; any interest rate on top is not published.',
   'Accounts receivable aging; Accounts payable aging; Financial statements; Bank Statements; Customer list'),
  ('Asset-Based Lending', 'ABL', 'Asset-Based Lending', 25000, 25000000, NULL, NULL::numeric, NULL::numeric, 12, 60,
   'A credit line sized on the business''s receivables and other assets. Recent published deals range from $2.5 million to $20 million.',
   'For companies that do not fit bank credit: fast growth, turnarounds, weaker credit, debtor-in-possession. Rates and advance rates are quoted per deal and are not published.',
   'Accounts receivable aging; Accounts payable aging; Inventory report; Financial statements; Balance Sheet; Profit and Loss Statement; Bank Statements'),
  ('Freight Factoring (Porter Freight Funding)', 'FACTORING', 'Invoice Factoring', 25000, 25000000, 'monthly', 0.4::numeric, 5.0::numeric, NULL::int, NULL::int,
   'Factoring for trucking companies, owner-operators and freight brokers through Porter''s transportation division, Porter Freight Funding.',
   'Carriers and freight brokers with delivered loads. Pricing is per invoice; the freight division''s own rates are not published, so the main factoring range is shown.',
   'Rate confirmations; Bills of lading / proof of delivery; Accounts receivable aging; Carrier authority; Certificate of insurance'),
  ('Purchase Order Financing', 'PO', 'Purchase Order Financing', 25000, 25000000, NULL, NULL::numeric, NULL::numeric, NULL::int, NULL::int,
   'Pays suppliers so the business can fill confirmed customer orders. Listed among Porter''s products by an outside review (Fortunly); Porter''s own site gives no details.',
   'Confirm with Porter before quoting: amounts, rates and requirements are not published.',
   'Purchase order; Supplier quote or invoice; Customer list; Financial statements'),
  ('Bridge Loan (with One Banc One)', 'TERM', 'Term Loan', 1000000, 5000000, NULL, NULL::numeric, NULL::numeric, 3, 12,
   'Short bridge loan of $1 million to $5 million for 90 days to 12 months, at 25% to 40% of the value of the security.',
   'Reported by an outside review (Fortunly) as offered with One Banc One. Rate is not published. Confirm with Porter before quoting.',
   'Financial statements; Balance Sheet; Profit and Loss Statement; Bank Statements; Details of the security offered')
) AS p(name, category, category_label, amount_min, amount_max, rate_kind, rate_min, rate_max, term_min, term_max, description, eligibility, documents)
WHERE NOT EXISTS (SELECT 1 FROM lender_products lp WHERE lp.lender_id = l.id AND lp.name = p.name);
