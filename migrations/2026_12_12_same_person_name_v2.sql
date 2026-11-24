-- BF_SERVER_DUP_NAMES_v2 (2026-11-24) - a shared first letter alone ("Dolly" / "Dylan" Myerson) is two people.
-- The forename now matches when identical, a prefix of the other (Mike/Michael), the same first two letters
-- (both 3+ letters), or when one of them is only an initial ("J" / "John"). Idempotent (CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION bf_same_person_name(a text, b text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_catalog AS
$FN$
DECLARE na text; nb text; sa text; sb text; fa text; fb text;
BEGIN
  na := bf_norm_name(a); nb := bf_norm_name(b);
  IF na = '' OR nb = '' THEN RETURN false; END IF;
  IF na = nb THEN RETURN true; END IF;
  sa := bf_surname(a); sb := bf_surname(b);
  IF sa IS DISTINCT FROM sb OR length(coalesce(sa,'')) < 2 THEN RETURN false; END IF;
  fa := bf_forename(a); fb := bf_forename(b);
  RETURN fa = fb
      OR (length(fa) >= 3 AND fb LIKE fa || '%')
      OR (length(fb) >= 3 AND fa LIKE fb || '%')
      OR (length(fa) >= 3 AND length(fb) >= 3 AND left(fa, 2) = left(fb, 2))
      OR ((length(fa) = 1 OR length(fb) = 1) AND left(fa, 1) = left(fb, 1));
END;
$FN$;
