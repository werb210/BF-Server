// BF_SERVER_v828_BOREAL_PACKAGE_PREFILL - a zip exported from Boreal (the staff portal's application package) carries
// application-fields.json: every field of the original application as flat dotted keys ("company.legalName",
// "borrower.phone", "kyc.fundingAmount"). Read the fields straight from it - exact, no OCR or AI guessing.
import { normalizePrefill, type BrokerPrefill } from "./extract.js";

export const BOREAL_FIELDS_RE = /(^|\/)application-fields\.json$/i;

type Flat = Record<string, unknown>;

/** The first non-empty value among the keys (in order). */
function first(f: Flat, keys: string[]): unknown {
  for (const k of keys) {
    const v = f[k];
    if (v !== undefined && v !== null && String(v).trim() !== "" && String(v).trim().toLowerCase() !== "none") return v;
  }
  return null;
}

const bases = (group: string[]) => (field: string) => group.flatMap((g) => [`${g}.${field}`, `formData.${g}.${field}`]);

/** BrokerPrefill from the flat key/value object in application-fields.json; null when it is not a Boreal export. */
export function prefillFromBorealFields(raw: unknown): BrokerPrefill | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Flat;
  const keys = Object.keys(f);
  if (!keys.some((k) => /^(formData\.)?(company|business|borrower|applicant|kyc)\./.test(k))) return null;
  const biz = bases(["company", "business", "business_info"]);
  const who = bases(["borrower", "applicant", "applicant_info"]);
  const kyc = bases(["kyc", "kyc_answers", "financials"]);
  const pick = (fn: (x: string) => string[], ...fields: string[]) => first(f, fields.flatMap(fn));
  const fullName = String(pick(who, "fullName") ?? "").trim();
  const partnerFirst = pick(who, "partnerFirstName");
  return normalizePrefill({
    kyc: {
      fundingAmount: pick(kyc, "fundingAmount") ?? first(f, ["Requested Amount"]),
      purposeOfFunds: pick(kyc, "purposeOfFunds"),
      lookingFor: pick(kyc, "lookingFor"),
      businessLocation: pick(kyc, "businessLocation"),
      industry: pick(kyc, "industry") ?? pick(biz, "industry"),
      yearsInBusiness: pick(kyc, "yearsInBusiness", "salesHistoryYears", "salesHistory"),
      annualRevenue: pick(kyc, "annualRevenue", "revenueLast12Months"),
      monthlyRevenue: pick(kyc, "monthlyRevenue", "avgMonthlyRevenue"),
      accountsReceivable: pick(kyc, "accountsReceivable", "arBalance"),
      fixedAssets: pick(kyc, "fixedAssets", "fixedAssetsValue"),
    },
    business: {
      legalName: pick(biz, "legalName") ?? first(f, ["Application Name"]),
      businessName: pick(biz, "businessName", "companyName", "dba"),
      address: pick(biz, "address", "street"),
      city: pick(biz, "city"),
      state: pick(biz, "state", "province"),
      zip: pick(biz, "zip", "postalCode"),
      phone: pick(biz, "phone"),
      website: pick(biz, "website"),
      startDate: pick(biz, "startDate"),
      businessStructure: pick(biz, "businessStructure", "entityType"),
      employees: pick(biz, "employees", "numberOfEmployees"),
      craBusinessNumber: pick(biz, "craBusinessNumber", "businessNumber"),
      naicsCode: pick(biz, "naicsCode"),
    },
    applicant: {
      firstName: pick(who, "firstName") ?? (fullName ? fullName.split(/\s+/)[0] : null),
      lastName: pick(who, "lastName") ?? (fullName.includes(" ") ? fullName.split(/\s+/).slice(1).join(" ") : null),
      email: pick(who, "email"),
      phone: pick(who, "phone", "mobile"),
      dob: pick(who, "dob", "dateOfBirth"),
      street: pick(who, "street", "address", "homeAddress"),
      city: pick(who, "city"),
      state: pick(who, "state", "province"),
      zip: pick(who, "zip", "postalCode"),
      ownership: pick(who, "ownership", "ownershipPercent"),
      title: pick(who, "title"),
    },
    partner: partnerFirst ? {
      firstName: partnerFirst,
      lastName: pick(who, "partnerLastName"),
      email: pick(who, "partnerEmail"),
      phone: pick(who, "partnerPhone"),
      dob: pick(who, "partnerDob", "partnerDateOfBirth"),
      street: pick(who, "partnerStreet", "partnerAddress"),
      city: pick(who, "partnerCity"),
      state: pick(who, "partnerState", "partnerProvince"),
      zip: pick(who, "partnerZip", "partnerPostalCode"),
      ownership: pick(who, "partnerOwnership", "partnerOwnershipPercent"),
      title: pick(who, "partnerTitle"),
    } : null,
  });
}
