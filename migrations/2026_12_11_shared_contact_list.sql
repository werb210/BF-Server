-- BF_SERVER_SHARED_CONTACTS_v1 (2026-11-24) - one list of brokers, lenders and banks across Boreal Financial, Boreal Risk
-- Management (PGI) and Keystone. A list goes in once; each silo is filled from it (directory_brand_status says where each
-- person went and what has happened there). Loading a list never emails anyone.
CREATE TABLE IF NOT EXISTS directory_orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_key text NOT NULL,
  domain text,
  kind text NOT NULL DEFAULT 'broker',
  country text,
  region text,
  city text,
  website text,
  phone text,
  address text,
  research jsonb NOT NULL DEFAULT '{}'::jsonb,
  sources text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS directory_orgs_domain_idx ON directory_orgs (lower(domain));
CREATE INDEX IF NOT EXISTS directory_orgs_name_idx ON directory_orgs (name_key, country);
CREATE INDEX IF NOT EXISTS directory_orgs_kind_idx ON directory_orgs (kind, country);

CREATE TABLE IF NOT EXISTS directory_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES directory_orgs(id) ON DELETE SET NULL,
  name text,
  name_key text,
  email text,
  phone text,
  title text,
  kind text NOT NULL DEFAULT 'broker',
  country text,
  region text,
  research jsonb NOT NULL DEFAULT '{}'::jsonb,
  sources text[] NOT NULL DEFAULT '{}'::text[],
  all_brands_opt_out boolean NOT NULL DEFAULT false,
  bad_address boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS directory_people_email_uq ON directory_people (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS directory_people_org_idx ON directory_people (org_id);
CREATE INDEX IF NOT EXISTS directory_people_kind_idx ON directory_people (kind, country);

CREATE TABLE IF NOT EXISTS directory_brand_status (
  person_id uuid NOT NULL REFERENCES directory_people(id) ON DELETE CASCADE,
  brand text NOT NULL CHECK (brand IN ('BF', 'BI', 'KS')),
  status text NOT NULL DEFAULT 'loaded',
  consent_basis text,
  consent_source text,
  silo_record_id text,
  last_activity text,
  last_activity_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, brand)
);
CREATE INDEX IF NOT EXISTS directory_brand_status_brand_idx ON directory_brand_status (brand, status);

CREATE TABLE IF NOT EXISTS directory_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_name text NOT NULL,
  kind text NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  routing jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
