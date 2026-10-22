// BF_SERVER_v846_FRAUD - the facts about an application the checks compare: who applied, the business, its contact
// details and what was claimed. Read the same way the portal's Application tab reads them (metadata.applicant /
// borrower / formData / broker_prefill), then the linked contact and company rows fill any gaps.

export type Person = { name: string | null; firstName: string | null; lastName: string | null; dob: string | null; email: string | null; phone: string | null; address: string | null };

export type AppProfile = {
  applicationId: string;
  createdAt: string | null;
  pipelineState: string | null;
  fraudConfirmed: boolean;
  ownerUserId: string | null;
  companyId: string | null;
  contactId: string | null;
  businessName: string | null;
  businessNumber: string | null;
  website: string | null;
  businessPhone: string | null;
  businessAddress: string | null;
  businessProvince: string | null;
  businessCountry: string | null;
  claimedAnnualRevenue: { min: number; max: number } | null;
  /** What the applicant said about existing debt / advances, lower-cased text (empty when nothing said). */
  disclosedDebtText: string;
  applicant: Person;
  owners: Person[];
};

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function str(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** "$1.2M", "250k", "500,000", "$500k-$1M", "1M+" -> { min, max } in dollars. */
export function parseMoneyRange(v: unknown): { min: number; max: number } | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return { min: v, max: v };
  const s = String(v ?? "").toLowerCase().replace(/,/g, "");
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(k|m|mm|million|thousand)?/g)]
    .map((m) => {
      const n = Number(m[1]);
      const u = m[2] ?? "";
      return u === "k" || u === "thousand" ? n * 1_000 : u === "m" || u === "mm" || u === "million" ? n * 1_000_000 : n;
    })
    .filter((n) => Number.isFinite(n) && n >= 1000);
  if (!nums.length) return null;
  if (nums.length === 1) return /\+|over|more than|above/.test(s) ? { min: nums[0]!, max: nums[0]! * 2 } : { min: nums[0]!, max: nums[0]! };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

function person(o: Obj | null | undefined): Person {
  const p = isObj(o) ? o : {};
  const first = str(p.firstName, p.first_name);
  const last = str(p.lastName, p.last_name);
  const name = str(p.fullName, p.full_name, p.name, [first, last].filter(Boolean).join(" ") || null);
  const address = str(
    p.address, p.street && [p.street, p.city, p.province ?? p.state, p.zip ?? p.postalCode].filter(Boolean).join(", "),
    p.address_street && [p.address_street, p.address_city, p.address_state, p.address_zip].filter(Boolean).join(", "),
  );
  return {
    name, firstName: first, lastName: last,
    dob: str(p.dob, p.dateOfBirth, p.date_of_birth, p.birthDate),
    email: str(p.email), phone: str(p.phone, p.mobilePhone, p.cellPhone, p.homePhone),
    address,
  };
}

function mergePerson(a: Person, b: Person): Person {
  return {
    name: a.name ?? b.name, firstName: a.firstName ?? b.firstName, lastName: a.lastName ?? b.lastName,
    dob: a.dob ?? b.dob, email: a.email ?? b.email, phone: a.phone ?? b.phone, address: a.address ?? b.address,
  };
}

export type ProfileRows = {
  app: Obj;
  contact?: Obj | null;
  company?: Obj | null;
};

export function buildProfile(rows: ProfileRows): AppProfile {
  const app = rows.app ?? {};
  const md: Obj = isObj(app.metadata) ? app.metadata : {};
  const fd: Obj = isObj(md.formData) ? md.formData : {};
  const bp: Obj = isObj(md.broker_prefill) ? md.broker_prefill : {};
  const applicantSrc = [md.applicant, md.borrower, fd.applicant, bp.applicant].find(isObj) ?? {};
  const businessSrc: Obj = [md.company, md.business, fd.business, bp.business].find(isObj) ?? {};
  const kyc: Obj = [md.kyc, md.kyc_responses, fd.kyc, bp.kyc].find(isObj) ?? {};
  const contact = rows.contact ?? null;
  const company = rows.company ?? null;

  const applicant = mergePerson(person(applicantSrc), person(contact ? {
    name: contact.name, firstName: contact.first_name, lastName: contact.last_name, dob: contact.dob ? String(contact.dob).slice(0, 10) : null,
    email: contact.email, phone: contact.phone, address_street: contact.address_street, address_city: contact.address_city,
    address_state: contact.address_state, address_zip: contact.address_zip,
  } : null));
  if (!applicant.email) applicant.email = str(kyc.email);
  if (!applicant.phone) applicant.phone = str(kyc.phone, md.readiness_phone);
  if (!applicant.name) applicant.name = str(kyc.fullName, [kyc.firstName, kyc.lastName].filter(Boolean).join(" ") || null);

  const ownersRaw: unknown[] = Array.isArray(md.owners) ? md.owners
    : [md.partner, isObj(md.applicant) ? md.applicant.partner : null, isObj(fd.applicant) ? fd.applicant.partner : null].filter(isObj);
  const extra = isObj(md.applicant) && Array.isArray(md.applicant.additionalShareholders) ? md.applicant.additionalShareholders : [];
  const owners = [...ownersRaw, ...extra].filter(isObj).map(person).filter((p) => p.name);

  const businessAddress = str(
    businessSrc.address && [businessSrc.address, businessSrc.city, businessSrc.province ?? businessSrc.state, businessSrc.postalCode ?? businessSrc.zip].filter(Boolean).join(", "),
    company?.address_street && [company.address_street, company.address_city, company.address_state, company.address_zip].filter(Boolean).join(", "),
  );
  const revenue = parseMoneyRange(str(kyc.annualRevenue, kyc.revenueLast12Months, md.revenueLast12Months, kyc.salesHistory, businessSrc.estimatedRevenue))
    ?? parseMoneyRange(company?.annual_revenue ?? company?.estimated_annual_revenue);
  const debtText = [md.existingDebt, md.existing_debt, kyc.existingDebt, kyc.existingLoans, kyc.currentDebt, md.debts, md.debt, fd.debt]
    .map((v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ").toLowerCase().trim();

  return {
    applicationId: String(app.id ?? ""),
    createdAt: app.created_at ? new Date(app.created_at).toISOString() : null,
    pipelineState: str(app.pipeline_state),
    fraudConfirmed: Boolean(app.fraud_confirmed_at),
    ownerUserId: str(app.owner_user_id),
    companyId: str(app.company_id),
    contactId: str(app.contact_id),
    businessName: str(businessSrc.legalName, businessSrc.businessName, businessSrc.companyName, app.business_legal_name, company?.legal_name, company?.name, kyc.companyName, kyc.businessName),
    businessNumber: str(businessSrc.businessNumber, businessSrc.business_number, businessSrc.bn, businessSrc.taxId, businessSrc.tax_id, businessSrc.corporationNumber, kyc.businessNumber),
    website: str(businessSrc.website, company?.website, company?.domain, kyc.website),
    businessPhone: str(businessSrc.phone, businessSrc.businessPhone, company?.phone),
    businessAddress,
    businessProvince: str(businessSrc.province, businessSrc.state, company?.address_state, company?.province, kyc.businessLocation, md.province),
    businessCountry: str(businessSrc.country, company?.address_country, company?.country, md.businessCountry, md.country, kyc.country),
    claimedAnnualRevenue: revenue,
    disclosedDebtText: debtText,
    applicant,
    owners,
  };
}
