-- Backfill applications.contact_id from application_contacts for rows where it
-- was never set (the submit path linked contacts in the join table but did not
-- populate applications.contact_id). Downstream name resolution — conversation
-- titles, CRM People panel, "contact linked" checks — reads applications.contact_id,
-- so NULL there showed the application UUID / "no contact linked". Idempotent:
-- only touches rows that are still NULL; prefers the applicant link.
UPDATE applications a
   SET contact_id = ac.contact_id
  FROM (
        SELECT DISTINCT ON (application_id) application_id, contact_id
          FROM application_contacts
         ORDER BY application_id,
                  CASE role WHEN 'applicant' THEN 0
                            WHEN 'partner'   THEN 1
                            WHEN 'guarantor' THEN 2
                            ELSE 3 END
       ) ac
 WHERE a.id = ac.application_id
   AND a.contact_id IS NULL;
