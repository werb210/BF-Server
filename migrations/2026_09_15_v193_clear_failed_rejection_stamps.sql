-- BF_SERVER_REJECTION_EMAIL_GUARD_v193
-- Applications rejected before v193 had rejection_email_sent_at stamped even when
-- the mail never went out. Clear the stamp for any rejected application whose
-- linked contact has no email, so that adding an address later lets the notice
-- send instead of returning already_sent forever.
UPDATE applications a
   SET rejection_email_sent_at = NULL
  FROM contacts c
 WHERE c.id = a.contact_id
   AND a.rejection_email_sent_at IS NOT NULL
   AND COALESCE(NULLIF(TRIM(c.email), ''), NULL) IS NULL;
