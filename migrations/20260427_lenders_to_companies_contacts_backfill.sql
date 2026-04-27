-- BF_LENDER_TO_CRM_v38 — Block 38-D
-- For every existing lender, ensure a matching companies row (by lender_id link)
-- and a contacts row for the primary contact. Idempotent: re-running will not
-- duplicate rows because we match by lender_id-link in metadata.
-- Adds a helper column companies.lender_id (nullable) so dual-writes can find
-- the existing companies row for an updated lender.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS lender_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_companies_lender_id ON companies(lender_id);

-- Mirror lender → companies. We synthesize a stable UUID per lender by
-- reusing lender id in the companies row's lender_id column.
INSERT INTO companies (
    id, name, phone, status, country, silo, types_of_financing, lender_id,
    created_at, updated_at
)
SELECT
    gen_random_uuid(),
    COALESCE(NULLIF(TRIM(l.name), ''), 'Unnamed Lender'),
    l.phone,
    'active',
    COALESCE(l.country::text, 'CA'),
    COALESCE(l.silo, 'BF'),
    ARRAY['LENDER']::text[],
    l.id,
    COALESCE(l.created_at, now()),
    COALESCE(l.updated_at, now())
FROM lenders l
WHERE NOT EXISTS (
    SELECT 1 FROM companies c WHERE c.lender_id = l.id
);

-- Mirror lender's primary contact → contacts.
-- Match the previously inserted (or pre-existing) companies row by lender_id.
INSERT INTO contacts (
    id, company_id, name, email, phone, status, silo, lead_status, tags,
    lifecycle_stage, role, created_at, updated_at
)
SELECT
    gen_random_uuid(),
    c.id,
    COALESCE(NULLIF(TRIM(l.contact_name), ''), 'Lender Contact'),
    NULLIF(TRIM(l.contact_email), ''),
    NULLIF(TRIM(l.contact_phone), ''),
    'active',
    COALESCE(l.silo, 'BF'),
    'Lender',
    ARRAY['lender']::text[],
    'lender',
    'lender_primary',
    COALESCE(l.created_at, now()),
    COALESCE(l.updated_at, now())
FROM lenders l
JOIN companies c ON c.lender_id = l.id
WHERE
    (
        NULLIF(TRIM(l.contact_name), '') IS NOT NULL
        OR NULLIF(TRIM(l.contact_email), '') IS NOT NULL
        OR NULLIF(TRIM(l.contact_phone), '') IS NOT NULL
    )
    AND NOT EXISTS (
        SELECT 1 FROM contacts ct
        WHERE ct.company_id = c.id AND ct.role = 'lender_primary'
    );

-- Unique on lender_id where it's set, so the dual-write upsert path works.
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_lender_id
  ON companies(lender_id) WHERE lender_id IS NOT NULL;
