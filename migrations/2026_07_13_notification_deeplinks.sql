-- BF_SERVER_NOTIF_DEEPLINK_v1
-- Website contact-form notifications deep-link to /crm/contacts/<id>, but ONLY when the
-- contact was created successfully. When contact creation failed (or the notification
-- predates the deep-link change) the code fell back to /crm/leads/<lead id> - and
-- /crm/leads is NOT A ROUTE IN THE PORTAL. React Router cannot match it, so clicking the
-- notification dumps staff on the CRM list with no idea who they were supposed to call.
--
-- Repair the existing rows by resolving the lead to its contact via email, which is the
-- one field crm_leads and contacts reliably share.
UPDATE notifications n
   SET context_url = '/crm/contacts/' || c.id::text
  FROM crm_leads l
  JOIN contacts c
    ON c.silo = 'BF'
   AND c.email IS NOT NULL
   AND lower(c.email) = lower(l.email)
 WHERE n.context_url LIKE '/crm/leads/%'
   AND l.id::text = replace(n.context_url, '/crm/leads/', '');

-- Anything still pointing at the dead route has no matching contact. Send it to the CRM
-- list rather than a URL that silently resolves to nothing.
UPDATE notifications
   SET context_url = '/crm/contacts'
 WHERE context_url LIKE '/crm/leads/%';
