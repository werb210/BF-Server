-- BF_SERVER_v958_MARKETING_CONTACTS - "Marketing contact" yes/no on every contact. Campaign emails, campaign texts,
-- sequence emails/texts and automation marketing texts go only to marketing contacts, so thousands of contacts can
-- sit in the CRM while only the chosen ones are marketed to.
-- Everyone already in the CRM (and anyone added by hand, a form, an application or a lead ad) is a marketing contact
-- (the default). Contacts brought in by an import are NOT, unless the import says so.
-- A contact who unsubscribes (marketing_opt_out) stops being a marketing contact, whichever way the unsubscribe
-- arrived (email link, SendGrid, a call outcome, a privacy request): the trigger below covers every path.
-- Safe to run again.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_contact boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS contacts_marketing_contact_idx ON contacts (silo) WHERE marketing_contact = false;

CREATE OR REPLACE FUNCTION bf_unsubscribed_not_marketing() RETURNS trigger AS $$
BEGIN
  IF COALESCE(NEW.marketing_opt_out, false) THEN
    NEW.marketing_contact := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contacts_unsubscribed_not_marketing ON contacts;
CREATE TRIGGER contacts_unsubscribed_not_marketing
  BEFORE INSERT OR UPDATE OF marketing_opt_out, marketing_contact ON contacts
  FOR EACH ROW EXECUTE FUNCTION bf_unsubscribed_not_marketing();

UPDATE contacts SET marketing_contact = false WHERE COALESCE(marketing_opt_out, false) = true AND marketing_contact = true;
