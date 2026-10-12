// BF_SERVER_v791_SUBMIT_COMPLETENESS
// Server-side re-check of the wizard's required answers on the applicant submit
// (POST /api/client/applications/:token/submit). The client already refuses to
// submit an incomplete file, but a stale tab, a deep link or a hand-built request
// could still send one. The rules below are a faithful port of BF-client
// client-app/src/wizard/stepValidation.ts (Steps 1, 3 and 4) and the path helpers
// in client-app/src/wizard/wizardSchema.ts - same field names, same skip rules,
// same labels. Keep the two in lockstep: when the wizard changes a rule, change it
// here too.
//
// Only the applicant submit uses this. Staff, broker import, lender and Maya paths
// do not.

type Rec = Record<string, any>;

/** Validate.required from BF-client utils/validate.ts. */
function required(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** Validate.phone from BF-client utils/validate.ts. */
function validPhone(value: unknown): boolean {
  const digits = String(value ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten);
}

/** getCountryCode from BF-client utils/location.ts. */
function countryCode(location: unknown): string {
  if (location === "Canada") return "CA";
  if (location === "United States") return "US";
  return "";
}

/** normalizeFundingIntent from BF-client constants/wizard.ts. */
function fundingIntent(value: unknown): "" | "WORKING_CAPITAL" | "EQUIPMENT" | "BOTH" {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed === "WORKING_CAPITAL" || trimmed === "EQUIPMENT" || trimmed === "BOTH") return trimmed;
  const n = trimmed.toLowerCase();
  if (n === "capital" || n === "working capital") return "WORKING_CAPITAL";
  if (n === "equipment" || n === "equipment financing") return "EQUIPMENT";
  if (n === "both" || n === "capital & equipment" || n === "both capital & equipment") return "BOTH";
  return "";
}

// ---- wizardSchema.ts path helpers -------------------------------------------

export function isStartupPathKyc(kyc?: Rec): boolean {
  const purpose = String(kyc?.purposeOfFunds ?? "").trim();
  const sales = String(kyc?.salesHistory ?? kyc?.yearsInBusiness ?? "").trim();
  return purpose === "Start up Funding" || purpose === "SBA / Start-up" || sales === "Zero";
}

export const MEDIA_INDUSTRY = "Media, movies, TV shows, video game production";
export function isMediaPathKyc(kyc?: Rec): boolean {
  const purpose = String(kyc?.purposeOfFunds ?? "").trim();
  const industry = String(kyc?.industry ?? "").trim();
  return purpose === "Media Financing" || industry === MEDIA_INDUSTRY;
}

export type WizardApp = {
  kyc?: Rec;
  business?: Rec;
  applicant?: Rec;
  productCategory?: unknown;
  selectedProductType?: unknown;
  selectedProduct?: Rec;
  eligibleProducts?: unknown;
};

export function isMediaWizardPath(app?: WizardApp): boolean {
  const candidates = [app?.productCategory, app?.selectedProductType, app?.selectedProduct?.category, app?.selectedProduct?.product_type];
  for (const c of candidates) if (/^MEDIA/.test(String(c ?? "").toUpperCase())) return true;
  return isMediaPathKyc(app?.kyc ?? {});
}

export function isSbaWizardPath(app?: WizardApp): boolean {
  const candidates = [
    app?.productCategory,
    app?.selectedProductType,
    app?.selectedProduct?.category,
    app?.selectedProduct?.product_type,
    app?.selectedProduct?.type,
    app?.selectedProduct?.name,
  ];
  for (const c of candidates) {
    if (String(c ?? "").toUpperCase().includes("SBA")) return true;
  }
  return isStartupPathKyc(app?.kyc ?? {});
}

/** isAccordLOCApp from BF-client wizard/accordRisk.ts. */
function isAccordLOCApp(app: WizardApp): boolean {
  const selected = String(app?.productCategory ?? app?.selectedProductType ?? "").toUpperCase();
  const selectedIsLOC = selected === "LOC" || selected === "LINE_OF_CREDIT" || selected.includes("LINE OF CREDIT");
  if (!selectedIsLOC) return false;
  const products = Array.isArray(app?.eligibleProducts) ? app.eligibleProducts : [];
  return products.some((product: any) => product?.isAccord === true);
}

// ---- stepValidation.ts ------------------------------------------------------

function step1FieldErrors(kyc: Rec, cc: string): Record<string, boolean> {
  const values = kyc || {};
  const intent = fundingIntent(values.lookingFor);
  const capitalRequired = intent === "WORKING_CAPITAL" || intent === "BOTH";
  const equipmentRequired = intent === "EQUIPMENT" || intent === "BOTH";
  return {
    lookingFor: !required(values.lookingFor),
    fundingAmount: capitalRequired && !required(values.fundingAmount),
    equipmentAmount: equipmentRequired && !required(values.equipmentAmount),
    businessLocation: !required(values.businessLocation) || values.businessLocation === "Other",
    industry: !isStartupPathKyc(values) && !isMediaPathKyc(values) && !required(values.industry),
    purposeOfFunds: !required(values.purposeOfFunds),
    salesHistory: false,
    revenueLast12Months: false,
    monthlyRevenue:
      cc === "CA" && !isMediaPathKyc(values)
        ? !required(values.monthlyRevenue) || values.monthlyRevenue === "Under $10,000"
        : false,
    accountsReceivable: false,
    fixedAssets: false,
  };
}

const STEP1_LABELS: Record<string, string> = {
  lookingFor: "what you are looking for",
  fundingAmount: "how much funding you need",
  equipmentAmount: "the equipment amount",
  businessLocation: "your business location",
  industry: "your industry",
  purposeOfFunds: "the purpose of the funds",
  monthlyRevenue: "your average monthly revenue",
};

function missingStep1(app: WizardApp): string[] {
  const kyc = app.kyc || {};
  const errors = step1FieldErrors(kyc, countryCode(kyc.businessLocation));
  return Object.entries(errors).filter(([, bad]) => bad).map(([key]) => STEP1_LABELS[key] ?? key);
}

const REQUIRED_STEP3: ReadonlyArray<readonly [string, string]> = [
  ["businessName", "business name"],
  ["businessStructure", "business structure"],
  ["address", "business address"],
  ["city", "city"],
  ["state", "province or state"],
  ["zip", "postal or ZIP code"],
  ["phone", "business phone"],
  ["startDate", "business start date"],
  ["employees", "number of employees"],
  ["estimatedRevenue", "estimated yearly revenue"],
];
const MEDIA_SKIP_STEP3 = new Set<string>(["employees", "estimatedRevenue"]);

function missingAccordStep3Fields(business: Rec, isAccordLOC: boolean): string[] {
  if (!isAccordLOC) return [];
  const v = business || {};
  const out: string[] = [];
  if (!required(v.fiscalYearEnd)) out.push("fiscal year end");
  if (!required(v.inBusinessSince)) out.push("the month and year the business started");
  if (v.mailingSameAsOperating === false) {
    if (!required(v.mailingAddress)) out.push("mailing address");
    if (!required(v.mailingCity)) out.push("mailing city");
    if (!required(v.mailingState)) out.push("mailing province or state");
    if (!required(v.mailingZip)) out.push("mailing postal or ZIP code");
  }
  return out;
}

function missingStep3(app: WizardApp): string[] {
  if (isSbaWizardPath(app)) return [];
  const values = app.business || {};
  const onMediaPath = isMediaWizardPath(app);
  const missing = [
    ...REQUIRED_STEP3.filter(([field]) => !(onMediaPath && MEDIA_SKIP_STEP3.has(field)) && !required(values[field])).map(([, label]) => label),
    ...missingAccordStep3Fields(values, isAccordLOCApp(app)),
  ];
  if (missing.length === 0 && !validPhone(values.phone)) {
    missing.push("a valid 10-digit business phone number");
  }
  return missing;
}

const REQUIRED_OWNER_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["firstName", "first name"],
  ["lastName", "last name"],
  ["email", "email"],
  ["phone", "phone number"],
  ["street", "street address"],
  ["city", "city"],
  ["state", "province or state"],
  ["zip", "postal or ZIP code"],
  ["dob", "date of birth"],
  ["ssn", "SIN / SSN"],
  ["ownership", "ownership %"],
];

function impliesMultipleOwners(applicant: Rec | undefined): boolean {
  const pct = Number(applicant?.ownership ?? 0);
  return Number.isFinite(pct) && pct > 0 && pct < 100;
}

function ownershipValid(applicant: Rec | undefined): boolean {
  const values = applicant || {};
  const partner = values.partner || {};
  const primary = Number(values.ownership || 0);
  const second = Number(partner.ownership || 0);
  const multi = impliesMultipleOwners(values);
  const rangeValid = primary >= 1 && primary <= 100 && (!multi || (second >= 1 && second <= 100));
  const totalValid = multi ? primary + second === 100 : primary === 100;
  return rangeValid && totalValid;
}

function missingStep4(app: WizardApp): string[] {
  const values = app.applicant || {};
  const out = REQUIRED_OWNER_FIELDS.filter(([field]) => !required(values[field])).map(([, label]) => label);
  if (impliesMultipleOwners(values)) {
    const partner = values.partner || {};
    for (const [field, label] of REQUIRED_OWNER_FIELDS) {
      if (!required(partner[field])) out.push(`partner ${label}`);
    }
  }
  if (!ownershipValid(values) && required(values.ownership)) {
    out.push("ownership adding up to 100% across every owner");
  }
  return out;
}

// ---- merging the submit payload with what is stored -------------------------

function asObject(v: unknown): Rec | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function firstObject(...vals: unknown[]): Rec | undefined {
  for (const v of vals) {
    const o = asObject(v);
    if (o) return o;
  }
  return undefined;
}

/** Field-by-field: the payload's answer when it has one, else the stored one. */
function mergeSlice(payload: Rec | undefined, ...stored: Array<Rec | undefined>): Rec | undefined {
  const layers = [payload, ...stored].filter((x): x is Rec => Boolean(x));
  if (layers.length === 0) return undefined;
  const out: Rec = {};
  for (let i = layers.length - 1; i >= 0; i--) {
    for (const [k, v] of Object.entries(layers[i])) {
      if (required(v) || !(k in out)) out[k] = v;
    }
  }
  return out;
}

function payloadKyc(app: Rec | undefined) { return firstObject(app?.kyc, app?.kyc_answers, app?.financialProfile); }
function payloadBusiness(app: Rec | undefined) { return firstObject(app?.business, app?.business_info, app?.company); }
function payloadApplicant(app: Rec | undefined) { return firstObject(app?.applicant, app?.applicant_info, app?.borrower); }

export type CompletenessResult =
  | { ok: true; checked: boolean; absent?: string[] }
  | { ok: false; step: 1 | 3 | 4; missing: string[] };

/**
 * Re-checks wizard Steps 1, 3 and 4 against the submit payload (`app`) merged
 * with the application's stored metadata (and metadata.formData).
 *
 * Conservative: a payload with none of the kyc / business / applicant slices, or
 * one where a slice is absent from both the payload and the stored record, is an
 * unrecognised shape and is allowed (checked: false), so a shape mismatch never
 * blocks a real application.
 */
export function checkSubmitCompleteness(payloadApp: unknown, storedMetadata: unknown): CompletenessResult {
  const app = asObject(payloadApp);
  const pKyc = payloadKyc(app);
  const pBusiness = payloadBusiness(app);
  const pApplicant = payloadApplicant(app);
  if (!pKyc && !pBusiness && !pApplicant) return { ok: true, checked: false };

  const meta = asObject(storedMetadata) ?? {};
  const form = asObject(meta.formData);

  const kyc = mergeSlice(pKyc, firstObject(meta.kyc, meta.financials), payloadKyc(form));
  const business = mergeSlice(pBusiness, firstObject(meta.business, meta.company), payloadBusiness(form));
  const applicantBase = mergeSlice(pApplicant, firstObject(meta.applicant, meta.borrower), payloadApplicant(form));
  let applicant = applicantBase;
  if (applicantBase) {
    const partner = mergeSlice(
      asObject(pApplicant?.partner),
      asObject(asObject(meta.applicant)?.partner),
      asObject(meta.partner),
      asObject(payloadApplicant(form)?.partner),
    );
    applicant = { ...applicantBase, ...(partner ? { partner } : {}) };
  }

  const pick = (...vals: unknown[]) => vals.find((v) => v !== undefined && v !== null);
  const wizardApp: WizardApp = {
    kyc,
    business,
    applicant,
    productCategory: pick(app?.productCategory, app?.product_category, meta.product_category, form?.productCategory),
    selectedProductType: pick(app?.selectedProductType, app?.selected_product_type, meta.selected_product_type, form?.selectedProductType),
    selectedProduct: firstObject(app?.selectedProduct, app?.selected_product, meta.selected_product, form?.selectedProduct),
    eligibleProducts: pick(app?.eligibleProducts, form?.eligibleProducts),
  };

  // The wizard always sends all three slices; anything less (an older client, a
  // test harness, a hand-built call) is a shape we do not recognise. Allow it and
  // say which slice was absent, rather than fail answers that were never asked for.
  const absent = ([["kyc", kyc], ["business", business], ["applicant", applicant]] as const)
    .filter(([, slice]) => !slice)
    .map(([name]) => name);
  if (absent.length > 0) return { ok: true, checked: false, absent };

  const steps: Array<[1 | 3 | 4, (a: WizardApp) => string[]]> = [
    [1, missingStep1],
    [3, missingStep3],
    [4, missingStep4],
  ];
  for (const [step, check] of steps) {
    const missing = check(wizardApp);
    if (missing.length > 0) return { ok: false, step, missing };
  }
  return { ok: true, checked: true };
}
