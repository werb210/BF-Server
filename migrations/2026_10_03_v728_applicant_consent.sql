-- BF_SERVER_APPLICANT_CONSENT_v728
-- Applicants were saved to the CRM with no texting consent recorded unless they ticked
-- the Step 6 box, so people who started but didn't finish never appeared on the SMS
-- screen. Record what the law already gives: an application is an inquiry (implied
-- consent for 6 months from the application) and a funded deal is a transaction
-- (implied consent for 2 years from funding). Express consent is never touched.
WITH funded AS (
  SELECT x.contact_id, max(x.funded_at) AS at FROM (
    SELECT a.contact_id, a.funded_at FROM applications a WHERE a.funded_at IS NOT NULL AND a.contact_id IS NOT NULL AND a.silo = 'BF'
    UNION ALL
    SELECT ac.contact_id, a.funded_at FROM application_contacts ac JOIN applications a ON a.id = ac.application_id WHERE a.funded_at IS NOT NULL AND a.silo = 'BF'
  ) x GROUP BY 1
)
UPDATE contacts c
   SET consent_basis = 'implied_transaction', consent_at = f.at, consent_source = 'funded deal (backfill)'
  FROM funded f
 WHERE f.contact_id = c.id AND NOT COALESCE(c.sms_consent, false)
   AND COALESCE(c.consent_basis, '') NOT IN ('express', 'implied_transaction');

WITH applied AS (
  SELECT x.contact_id, max(x.created_at) AS at FROM (
    SELECT a.contact_id, a.created_at FROM applications a WHERE a.contact_id IS NOT NULL AND a.silo = 'BF'
    UNION ALL
    SELECT ac.contact_id, a.created_at FROM application_contacts ac JOIN applications a ON a.id = ac.application_id WHERE a.silo = 'BF'
  ) x GROUP BY 1
)
UPDATE contacts c
   SET consent_basis = 'implied_inquiry', consent_at = a.at, consent_source = 'application (backfill)'
  FROM applied a
 WHERE a.contact_id = c.id AND NOT COALESCE(c.sms_consent, false)
   AND COALESCE(c.consent_basis, '') NOT IN ('express', 'implied_transaction', 'implied_inquiry');
