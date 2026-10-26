-- BF_SERVER_v856_CRM_UNIFY - one consistent CRM for BF, SLF and KS (BI has the same on BI-Server).
-- 1. companies.tags (the companies list, its tag filter and the bulk tag routes already read it, but the column was
--    never created) and companies.time_in_business (the company panel falls back to the application for the rest).
-- 2. Shared tag system: bf_norm_tag()/bf_norm_tags() (same rules as src/modules/crmUnify/tags.ts), each silo's extra
--    staff tags (crm_tag_definitions), and a one-off normalisation of every stored tag (case, spaces, duplicates,
--    "Contact form" -> contact_form) on contacts, companies and marketing sequence audiences.
-- 3. Company people added by hand (crm_company_people, HubSpot-style associations with a role) and people hidden
--    from a company (crm_company_people_hidden).
-- 4. Duplicates staff said are not duplicates (crm_duplicate_dismissals) and the company merge log (company_merges).
-- 5. Data clean-up batches with before-images for undo (crm_cleanup_batches, crm_cleanup_changes).
-- 6. Cached AI summaries with the sources used (crm_ai_summaries).
-- 7. Company repair: contacts get the company of their application (or of an application they are on), a company
--    named like the contact's company text, and contacts.company_name is filled from the linked company.
-- Safe to run more than once.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE companies ADD COLUMN IF NOT EXISTS time_in_business text;

CREATE OR REPLACE FUNCTION bf_norm_tag(t text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS
$FN$
  SELECT CASE x
           WHEN 'contactform' THEN 'contact_form'
           WHEN 'contact_us' THEN 'contact_form'
           WHEN 'website_contact_form' THEN 'contact_form'
           WHEN 'lenders' THEN 'lender'
           WHEN 'brokers' THEN 'broker'
           WHEN 'lawyers' THEN 'lawyer'
           WHEN 'attorney' THEN 'lawyer'
           WHEN 'referrers' THEN 'referrer'
           WHEN 'bookkeeper' THEN 'accountant'
           WHEN 'book_keeper' THEN 'accountant'
           WHEN 'accountants' THEN 'accountant'
           WHEN 'accountant_bookkeeper' THEN 'accountant'
           WHEN 'account_book_keeper' THEN 'accountant'
           WHEN 'accountant_book_keeper' THEN 'accountant'
           WHEN 'accountant_advisor' THEN 'accountant'
           WHEN 'cpa' THEN 'accountant'
           WHEN 'lawyer_advisor' THEN 'lawyer'
           WHEN 'attorney_advisor' THEN 'lawyer'
           WHEN 'insurance_advisor' THEN 'insurance'
           WHEN 'a_r_credit_insurance_advisor' THEN 'ar_credit_insurance'
           WHEN 'a_r_credit_insurance' THEN 'ar_credit_insurance'
           WHEN 'ar_credit_insurance_advisor' THEN 'ar_credit_insurance'
           WHEN 'accounts_receivable_credit_insurance' THEN 'ar_credit_insurance'
           WHEN 'booked_a_call' THEN 'booked_call'
           WHEN 'application_start' THEN 'application_started'
           WHEN 'credit_readiness_check' THEN 'credit_readiness'
           ELSE x
         END
    FROM (SELECT btrim(regexp_replace(regexp_replace(regexp_replace(lower(btrim(coalesce(t, ''))),
                 '[[:space:]/-]+', '_', 'g'), '[^a-z0-9_:]', '', 'g'), '_+', '_', 'g'), '_') AS x) s
$FN$;

CREATE OR REPLACE FUNCTION bf_norm_tags(tags text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS
$FN$
  SELECT coalesce(array_agg(n ORDER BY n), '{}'::text[])
    FROM (SELECT DISTINCT bf_norm_tag(t) AS n FROM unnest(coalesce(tags, '{}'::text[])) AS t) x
   WHERE n <> ''
$FN$;

UPDATE contacts SET tags = bf_norm_tags(tags) WHERE tags IS DISTINCT FROM bf_norm_tags(tags);
UPDATE companies SET tags = bf_norm_tags(tags) WHERE tags IS DISTINCT FROM bf_norm_tags(tags);
UPDATE marketing_sequences
   SET audience_tag = CASE WHEN audience_tag IS NULL THEN NULL ELSE nullif(bf_norm_tag(audience_tag), '') END,
       audience_include_tags = CASE WHEN audience_include_tags IS NULL THEN NULL ELSE bf_norm_tags(audience_include_tags) END,
       audience_exclude_tags = CASE WHEN audience_exclude_tags IS NULL THEN NULL ELSE bf_norm_tags(audience_exclude_tags) END
 WHERE audience_tag IS DISTINCT FROM (CASE WHEN audience_tag IS NULL THEN NULL ELSE nullif(bf_norm_tag(audience_tag), '') END)
    OR audience_include_tags IS DISTINCT FROM (CASE WHEN audience_include_tags IS NULL THEN NULL ELSE bf_norm_tags(audience_include_tags) END)
    OR audience_exclude_tags IS DISTINCT FROM (CASE WHEN audience_exclude_tags IS NULL THEN NULL ELSE bf_norm_tags(audience_exclude_tags) END);

CREATE INDEX IF NOT EXISTS companies_tags_gin_idx ON companies USING gin (tags);

CREATE TABLE IF NOT EXISTS crm_tag_definitions (
  silo        text NOT NULL,
  slug        text NOT NULL,
  label       text NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (silo, slug)
);

CREATE TABLE IF NOT EXISTS crm_company_people (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo        text NOT NULL,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'other',
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_company_people_role_check CHECK (role IN ('primary_applicant', 'partner', 'guarantor', 'accountant',
    'lawyer', 'bookkeeper', 'advisor', 'employee', 'other'))
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_company_people_uniq ON crm_company_people (company_id, contact_id);
CREATE INDEX IF NOT EXISTS crm_company_people_contact_idx ON crm_company_people (contact_id);

CREATE TABLE IF NOT EXISTS crm_company_people_hidden (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  person_key  text NOT NULL,
  silo        text NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, person_key)
);

CREATE TABLE IF NOT EXISTS crm_duplicate_dismissals (
  silo        text NOT NULL,
  entity      text NOT NULL CHECK (entity IN ('contact', 'company')),
  a_id        uuid NOT NULL,
  b_id        uuid NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (silo, entity, a_id, b_id)
);

CREATE TABLE IF NOT EXISTS company_merges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo            text NOT NULL,
  survivor_id     uuid NOT NULL,
  loser_id        uuid NOT NULL,
  moved           jsonb NOT NULL DEFAULT '{}'::jsonb,
  loser_snapshot  jsonb,
  merged_by       uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_cleanup_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo          text NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  change_count  integer NOT NULL DEFAULT 0,
  undone_at     timestamptz,
  undone_by     uuid
);

CREATE TABLE IF NOT EXISTS crm_cleanup_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES crm_cleanup_batches(id) ON DELETE CASCADE,
  entity        text NOT NULL CHECK (entity IN ('contact', 'company')),
  entity_id     uuid NOT NULL,
  field         text NOT NULL,
  before_value  text,
  after_value   text,
  reason        text
);
CREATE INDEX IF NOT EXISTS crm_cleanup_changes_batch_idx ON crm_cleanup_changes (batch_id);

CREATE TABLE IF NOT EXISTS crm_ai_summaries (
  silo          text NOT NULL,
  entity        text NOT NULL CHECK (entity IN ('contact', 'company')),
  entity_id     uuid NOT NULL,
  summary       text NOT NULL,
  business      text,
  sources       jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  generated_by  uuid,
  PRIMARY KEY (silo, entity, entity_id)
);

-- Company repair. Same silo only; never overwrites a link that is already there.
UPDATE contacts c
   SET company_id = x.company_id, updated_at = now()
  FROM (SELECT DISTINCT ON (a.contact_id) a.contact_id, a.company_id, a.silo
          FROM applications a
          JOIN companies co ON co.id = a.company_id AND co.silo = a.silo
         WHERE a.contact_id IS NOT NULL AND a.company_id IS NOT NULL
         ORDER BY a.contact_id, a.updated_at DESC NULLS LAST) x
 WHERE c.id = x.contact_id AND c.company_id IS NULL AND c.silo = x.silo;

UPDATE contacts c
   SET company_id = x.company_id, updated_at = now()
  FROM (SELECT DISTINCT ON (ac.contact_id) ac.contact_id, a.company_id, a.silo
          FROM application_contacts ac
          JOIN applications a ON a.id = ac.application_id
          JOIN companies co ON co.id = a.company_id AND co.silo = a.silo
         WHERE a.company_id IS NOT NULL
         ORDER BY ac.contact_id, a.updated_at DESC NULLS LAST) x
 WHERE c.id = x.contact_id AND c.company_id IS NULL AND c.silo = x.silo;

UPDATE contacts c
   SET company_id = x.id, updated_at = now()
  FROM (SELECT lower(btrim(name)) AS k, silo, min(id::text)::uuid AS id
          FROM companies
         WHERE coalesce(btrim(name), '') <> ''
         GROUP BY lower(btrim(name)), silo
        HAVING count(*) = 1) x
 WHERE c.company_id IS NULL
   AND coalesce(btrim(c.company_name), '') <> ''
   AND lower(btrim(c.company_name)) = x.k
   AND c.silo = x.silo;

UPDATE companies
   SET name = btrim(legal_name), updated_at = now()
 WHERE coalesce(btrim(name), '') = '' AND coalesce(btrim(legal_name), '') <> '';

UPDATE contacts c
   SET company_name = btrim(co.name)
  FROM companies co
 WHERE co.id = c.company_id
   AND coalesce(btrim(c.company_name), '') = ''
   AND coalesce(btrim(co.name), '') <> '';

-- 8. People linked from applications and the Professional Advisors form.
--    crm_company_people.detail holds the advisor type ("Accountant (CPA)", "Insurance", ...) and source says where the
--    link came from (staff, application, advisor_form). crm_contact_links ties an advisor to the client contact.
ALTER TABLE crm_company_people ADD COLUMN IF NOT EXISTS detail text;
ALTER TABLE crm_company_people ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'staff';

CREATE TABLE IF NOT EXISTS crm_contact_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo                text NOT NULL,
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  related_contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  relation            text NOT NULL DEFAULT 'advisor',
  detail              text,
  application_id      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_contact_links_not_self CHECK (contact_id <> related_contact_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_contact_links_uniq ON crm_contact_links (contact_id, related_contact_id, relation);
CREATE INDEX IF NOT EXISTS crm_contact_links_related_idx ON crm_contact_links (related_contact_id);

-- One-time jobs that run from code (the partner / guarantor / advisor backfill) record themselves here.
CREATE TABLE IF NOT EXISTS crm_backfill_runs (
  key         text PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result      jsonb
);

-- 9. Roles. The person an application belongs to is its primary applicant on the application's company (and on the
--    company their own record points at), so company People lists show "Primary applicant", never "Other".
INSERT INTO crm_company_people (silo, company_id, contact_id, role, source)
SELECT DISTINCT ON (x.company_id, x.contact_id) x.silo, x.company_id, x.contact_id, 'primary_applicant', 'application'
  FROM (
    SELECT a.silo, a.company_id, a.contact_id, a.updated_at
      FROM applications a
      JOIN companies co ON co.id = a.company_id AND co.silo = a.silo
      JOIN contacts c ON c.id = a.contact_id AND c.silo = a.silo AND c.merged_into_id IS NULL
     WHERE a.company_id IS NOT NULL AND a.contact_id IS NOT NULL
    UNION ALL
    SELECT a.silo, c.company_id, a.contact_id, a.updated_at
      FROM applications a
      JOIN contacts c ON c.id = a.contact_id AND c.silo = a.silo AND c.merged_into_id IS NULL
      JOIN companies co ON co.id = c.company_id AND co.silo = c.silo
     WHERE c.company_id IS NOT NULL
  ) x
 ORDER BY x.company_id, x.contact_id, x.updated_at DESC NULLS LAST
ON CONFLICT (company_id, contact_id) DO UPDATE
   SET role = 'primary_applicant', source = 'application'
 WHERE crm_company_people.role IN ('other', 'employee');

INSERT INTO crm_company_people (silo, company_id, contact_id, role, source)
SELECT DISTINCT ON (a.company_id, ac.contact_id) a.silo, a.company_id, ac.contact_id, ac.role, 'application'
  FROM application_contacts ac
  JOIN applications a ON a.id = ac.application_id
  JOIN companies co ON co.id = a.company_id AND co.silo = a.silo
  JOIN contacts c ON c.id = ac.contact_id AND c.silo = a.silo AND c.merged_into_id IS NULL
 WHERE ac.role IN ('partner', 'guarantor') AND a.company_id IS NOT NULL
 ORDER BY a.company_id, ac.contact_id, a.updated_at DESC NULLS LAST
ON CONFLICT (company_id, contact_id) DO UPDATE
   SET role = EXCLUDED.role, source = 'application'
 WHERE crm_company_people.role IN ('other', 'employee');

INSERT INTO application_contacts (application_id, contact_id, role)
SELECT a.id, a.contact_id, 'applicant'
  FROM applications a
  JOIN contacts c ON c.id = a.contact_id AND c.merged_into_id IS NULL
 WHERE a.contact_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_contacts ac WHERE ac.application_id = a.id AND ac.contact_id = a.contact_id)
ON CONFLICT DO NOTHING;

UPDATE contacts c
   SET role = 'applicant', is_primary_applicant = true, updated_at = now()
 WHERE coalesce(c.role, 'unknown') IN ('unknown', 'other')
   AND c.merged_into_id IS NULL
   AND EXISTS (SELECT 1 FROM applications a WHERE a.contact_id = c.id AND a.silo = c.silo);

-- 10. The "started an application, did not finish" call task: one per person, never after they submit.
--     Close the copies (keep the oldest open one) and every such task for someone who has submitted since; stop the
--     worker from picking up the other unfinished drafts of anyone who already has the task or has submitted.
UPDATE tasks t
   SET status = 'COMPLETED', completed_at = coalesce(t.completed_at, now()), updated_at = now()
 WHERE t.title = 'Call: started an application, did not finish'
   AND t.deleted_at IS NULL
   AND t.status <> 'COMPLETED'
   AND t.contact_id IS NOT NULL
   AND (EXISTS (SELECT 1 FROM applications a WHERE a.contact_id = t.contact_id AND a.submitted_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM tasks o
                    WHERE o.contact_id = t.contact_id
                      AND o.title = t.title
                      AND o.deleted_at IS NULL
                      AND o.status <> 'COMPLETED'
                      AND (o.created_at, o.id) < (t.created_at, t.id)));

UPDATE applications a
   SET abandon_task_created_at = now()
 WHERE a.submitted_at IS NULL
   AND a.abandon_task_created_at IS NULL
   AND a.contact_id IS NOT NULL
   AND (EXISTS (SELECT 1 FROM applications s WHERE s.contact_id = a.contact_id AND s.submitted_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM tasks t WHERE t.contact_id = a.contact_id AND t.title = 'Call: started an application, did not finish'));

-- 11. Stage history: an identical event written twice for the same application (same move, same trigger, within a
--     minute) is a double write; keep the first.
DELETE FROM application_stage_events e
 USING application_stage_events f
 WHERE e.application_id = f.application_id
   AND coalesce(e.from_stage, '') = coalesce(f.from_stage, '')
   AND e.to_stage = f.to_stage
   AND e.trigger = f.trigger
   AND e.created_at >= f.created_at
   AND e.created_at < f.created_at + interval '1 minute'
   AND (e.created_at, e.id::text) > (f.created_at, f.id::text);
