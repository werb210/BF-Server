-- BF_SERVER_v809_SMS_UPDATES_CONSENT
-- Carriers (Twilio RCS / A2P review) require the client to actively choose to receive
-- application texts with an unticked checkbox. The choice is kept per mobile number
-- (last 10 digits), because the client makes it on the sign-in screen, before any CRM
-- contact or application exists. Automatic application texts (status updates, document
-- requests, signing reminders) only go to numbers with consent = true.
CREATE TABLE IF NOT EXISTS sms_updates_consents (
  phone10      text PRIMARY KEY,
  consent      boolean NOT NULL,
  consent_text text,
  source       text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Clients who signed in before the checkbox existed agreed under the earlier sign-in
-- notice ("By entering your mobile number, you agree to receive text messages ... about
-- your application"). Keep texting them; anyone who replied STOP is left out.
INSERT INTO sms_updates_consents (phone10, consent, consent_text, source)
SELECT DISTINCT ON (p10) p10, true, NULL, 'prior_sign_in_notice'
  FROM (
    SELECT right(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) AS p10
      FROM contacts c
     WHERE COALESCE(c.sms_opt_out, false) = false
       AND (c.silo IS NULL OR c.silo = 'BF')
       AND (
         EXISTS (SELECT 1 FROM applications a WHERE a.contact_id = c.id)
         OR EXISTS (SELECT 1 FROM application_contacts ac WHERE ac.contact_id = c.id)
       )
  ) x
 WHERE length(p10) = 10
ON CONFLICT (phone10) DO NOTHING;
