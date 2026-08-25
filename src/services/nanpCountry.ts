// BF_SERVER_NANP_COUNTRY_v92
// Canada and the US share country code +1, so the country has to come from the
// area code. This is the complete set of Canadian NANP area codes as of 2025;
// anything else in +1 is treated as US.
//
// Deliberately a hint, not a fact. A mobile follows the person, not the
// business - a Toronto number running a Buffalo company reads as CA here. The
// caller marks it inferred so staff know it was derived rather than declared.
const CANADIAN_AREA_CODES = new Set<string>([
  "204","226","236","249","250","257","263","289",
  "306","343","354","365","367","368","382",
  "403","416","418","428","431","437","438","450","468","474",
  "506","514","519","548","579","581","584","587",
  "600","604","613","622","639","647","672","683",
  "705","709","742","753","778","780","782",
  "807","819","825","867","873","879",
  "902","905",
]);

export type NanpCountry = "CA" | "US" | null;

export function countryFromPhone(phone: string | null | undefined): NanpCountry {
  const digits = String(phone ?? "").replace(/[^0-9]/g, "");
  // Accept +1XXXXXXXXXX (11) or bare 10-digit national format.
  const national = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.length === 10
      ? digits
      : "";
  if (national.length !== 10) return null;
  const npa = national.slice(0, 3);
  // NANP area codes never start 0 or 1, and the second digit rules out some
  // service codes. A malformed number should read unknown, not US.
  if (!/^[2-9][0-9]{2}$/.test(npa)) return null;
  return CANADIAN_AREA_CODES.has(npa) ? "CA" : "US";
}
