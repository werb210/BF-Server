-- Backfill applications.contact_id from application_contacts for rows where it
-- was never set (the submit path linked contacts in the join table but did not
-- populate applications.contact_id). Downstream name resolution — conversation
-- titles, CRM People panel, "contact linked" checks — reads applications.contact_id,
-- so NULL there showed the application UUID / "no contact linked".
--
-- The JOIN to contacts is REQUIRED: some application_contacts rows reference a
-- contact_id that no longer exists in contacts (orphaned join rows). Without the
-- JOIN the UPDATE picks an orphaned id and violates applications_contact_id_fkey,
-- which aborts the migration and crash-loops startup. The JOIN skips those rows.
-- Idempotent: only touches rows that are still NULL; prefers the applicant link.
UPDATE applications a
   SET contact_id = ac.contact_id
  FROM (
        SELECT DISTINCT ON (ac2.application_id) ac2.application_id, ac2.contact_id
          FROM application_contacts ac2
          JOIN contacts c ON c.id = ac2.contact_id
         ORDER BY ac2.application_id,
                  CASE ac2.role WHEN 'applicant' THEN 0
                                WHEN 'partner'   THEN 1
                                WHEN 'guarantor' THEN 2
                                ELSE 3 END
       ) ac
 WHERE a.id = ac.application_id
   AND a.contact_id IS NULL;
