-- BF_SERVER_v961_PHONE_EXTENSION - an extension for every contact (and every lender rep).
-- Many business numbers only reach the person through an extension ("(213) 555-0142 x106"). The extension gets its own
-- column so the number itself stays a clean, callable number. However a number arrives (typed, imported, a form, an
-- API), an extension written on the end of it ("x106", "ext 106", "ext. 106", "extension 106", "#106") is moved to the
-- extension column by the trigger below. Existing numbers are tidied once. Safe to run again.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_extension text;
ALTER TABLE lender_reps ADD COLUMN IF NOT EXISTS phone_extension text;

CREATE OR REPLACE FUNCTION bf_split_phone_extension() RETURNS trigger AS $$
DECLARE
  m text[];
BEGIN
  IF NEW.phone IS NOT NULL THEN
    m := regexp_match(NEW.phone, '^(.*\d)[\s,;]*(?:x|ext\.?|extension|#)\s*\.?\s*(\d{1,8})\s*$', 'i');
    IF m IS NOT NULL AND length(regexp_replace(m[1], '\D', '', 'g')) >= 7 THEN
      NEW.phone := btrim(m[1]);
      NEW.phone_extension := m[2];
    END IF;
  END IF;
  IF NEW.phone_extension IS NOT NULL THEN
    NEW.phone_extension := NULLIF(regexp_replace(NEW.phone_extension, '\D', '', 'g'), '');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contacts_split_phone_extension ON contacts;
CREATE TRIGGER contacts_split_phone_extension BEFORE INSERT OR UPDATE OF phone, phone_extension ON contacts
  FOR EACH ROW EXECUTE FUNCTION bf_split_phone_extension();
DROP TRIGGER IF EXISTS lender_reps_split_phone_extension ON lender_reps;
CREATE TRIGGER lender_reps_split_phone_extension BEFORE INSERT OR UPDATE OF phone, phone_extension ON lender_reps
  FOR EACH ROW EXECUTE FUNCTION bf_split_phone_extension();

-- One-time tidy of numbers already saved with the extension on the end (the trigger does the split).
UPDATE contacts SET phone = phone WHERE phone ~* '\d[\s,;]*(x|ext\.?|extension|#)\s*\.?\s*\d{1,8}\s*$';
UPDATE lender_reps SET phone = phone WHERE phone ~* '\d[\s,;]*(x|ext\.?|extension|#)\s*\.?\s*\d{1,8}\s*$';
