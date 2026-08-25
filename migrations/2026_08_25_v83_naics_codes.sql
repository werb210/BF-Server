-- BF_SERVER_NAICS_v83
-- SBA Form 1919 requires a 6-digit NAICS code, and nothing in BF captures one -
-- Step 1 asks for a plain industry category instead. bi-server has this table
-- already (biNaicsRoutes.ts), but it lives on bi-pg01, a completely separate
-- database, so BF cannot read it. This is BF's own copy.
--
-- Two deliberate differences from the BI version:
--   1. No pg_trgm. It is not allow-listed on this Postgres, and the BI migration
--      creates it explicitly - copying that here would crash-loop the app on
--      startup, since migrations are fatal on error.
--   2. The BI seed is 64 Canadian codes and one US row. SBA applicants are US by
--      definition, so the US set is what actually matters here.
--
-- The table is a few hundred rows, so an ILIKE scan is cheap and no trigram
-- index is needed. A btree on lower(title) still serves prefix searches.

CREATE TABLE IF NOT EXISTS naics_codes (
  code       TEXT NOT NULL,
  country    TEXT NOT NULL,
  title      TEXT NOT NULL,
  description TEXT,
  cached_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (code, country)
);

CREATE INDEX IF NOT EXISTS naics_codes_title_idx ON naics_codes (lower(title));
CREATE INDEX IF NOT EXISTS naics_codes_country_code_idx ON naics_codes (country, code);

-- NAICS 2022, most common US small-business codes. Not exhaustive: this covers
-- the industries that actually apply for 7(a) money. Expand as gaps appear.
INSERT INTO naics_codes (code, country, title) VALUES
  ('111998','US','All Other Miscellaneous Crop Farming'),
  ('112990','US','All Other Animal Production'),
  ('115112','US','Soil Preparation, Planting, and Cultivating'),
  ('236115','US','New Single-Family Housing Construction'),
  ('236220','US','Commercial and Institutional Building Construction'),
  ('238110','US','Poured Concrete Foundation and Structure Contractors'),
  ('238160','US','Roofing Contractors'),
  ('238210','US','Electrical Contractors and Other Wiring Installation'),
  ('238220','US','Plumbing, Heating, and Air-Conditioning Contractors'),
  ('238320','US','Painting and Wall Covering Contractors'),
  ('238910','US','Site Preparation Contractors'),
  ('238990','US','All Other Specialty Trade Contractors'),
  ('311811','US','Retail Bakeries'),
  ('321918','US','Other Millwork (including Flooring)'),
  ('323111','US','Commercial Printing (except Screen and Books)'),
  ('332710','US','Machine Shops'),
  ('333514','US','Special Die and Tool, Die Set, Jig, and Fixture Manufacturing'),
  ('337110','US','Wood Kitchen Cabinet and Countertop Manufacturing'),
  ('339999','US','All Other Miscellaneous Manufacturing'),
  ('423120','US','Motor Vehicle Supplies and New Parts Merchant Wholesalers'),
  ('423830','US','Industrial Machinery and Equipment Merchant Wholesalers'),
  ('424410','US','General Line Grocery Merchant Wholesalers'),
  ('441110','US','New Car Dealers'),
  ('441330','US','Automotive Parts and Accessories Retailers'),
  ('444110','US','Home Centers'),
  ('445110','US','Supermarkets and Other Grocery Retailers'),
  ('445131','US','Convenience Retailers'),
  ('447110','US','Gasoline Stations with Convenience Stores'),
  ('448140','US','Family Clothing Stores'),
  ('453998','US','All Other Miscellaneous Retailers'),
  ('454110','US','Electronic Shopping and Mail-Order Houses'),
  ('484110','US','General Freight Trucking, Local'),
  ('484121','US','General Freight Trucking, Long-Distance, Truckload'),
  ('485310','US','Taxi and Ridesharing Services'),
  ('493110','US','General Warehousing and Storage'),
  ('511210','US','Software Publishers'),
  ('517121','US','Telecommunications Resellers'),
  ('518210','US','Computing Infrastructure Providers, Data Processing, Web Hosting'),
  ('522320','US','Financial Transactions Processing and Clearinghouse Activities'),
  ('524210','US','Insurance Agencies and Brokerages'),
  ('531210','US','Offices of Real Estate Agents and Brokers'),
  ('531311','US','Residential Property Managers'),
  ('532412','US','Construction, Mining, and Forestry Machinery Rental and Leasing'),
  ('541110','US','Offices of Lawyers'),
  ('541211','US','Offices of Certified Public Accountants'),
  ('541330','US','Engineering Services'),
  ('541511','US','Custom Computer Programming Services'),
  ('541512','US','Computer Systems Design Services'),
  ('541611','US','Administrative Management and General Management Consulting'),
  ('541613','US','Marketing Consulting Services'),
  ('541810','US','Advertising Agencies'),
  ('541990','US','All Other Professional, Scientific, and Technical Services'),
  ('561320','US','Temporary Help Services'),
  ('561730','US','Landscaping Services'),
  ('561740','US','Carpet and Upholstery Cleaning Services'),
  ('561790','US','Other Services to Buildings and Dwellings'),
  ('561990','US','All Other Support Services'),
  ('611430','US','Professional and Management Development Training'),
  ('621111','US','Offices of Physicians (except Mental Health Specialists)'),
  ('621210','US','Offices of Dentists'),
  ('621340','US','Offices of Physical, Occupational, Speech Therapists, Audiologists'),
  ('621610','US','Home Health Care Services'),
  ('623110','US','Nursing Care Facilities (Skilled Nursing Facilities)'),
  ('624410','US','Child316 Day Care Services'),
  ('713940','US','Fitness and Recreational Sports Centers'),
  ('721110','US','Hotels (except Casino Hotels) and Motels'),
  ('722320','US','Caterers'),
  ('722511','US','Full-Service Restaurants'),
  ('722513','US','Limited-Service Restaurants'),
  ('722515','US','Snack and Nonalcoholic Beverage Bars'),
  ('811111','US','General Automotive Repair'),
  ('811121','US','Automotive Body, Paint, and Interior Repair and Maintenance'),
  ('812112','US','Beauty Salons'),
  ('812320','US','Drycleaning and Laundry Services (except Coin-Operated)'),
  ('812910','US','Pet Care (except Veterinary) Services')
ON CONFLICT (code, country) DO NOTHING;
