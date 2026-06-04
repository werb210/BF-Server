export const REQUIRED_DOCUMENT_KEYS = [
  "bank_statements_6_months",
  "government_id",
  "void_cheque",
  "articles_of_incorporation",
  "business_license",
  "personal_net_worth",
  "equipment_quote",
  "equipment_invoice",
  "purchase_order",
  "accounts_receivable_aging",
  "accounts_payable_aging",
  "tax_returns",
  "financial_statements",
  "lease_agreement",
  "real_estate_schedule",
  // BF_SERVER_BLOCK_v303_COLLATERAL_DOCTYPES_v1 — Accord LOC doc types
  "flinks_banking",
  "cra_view_only_authorization",
  "real_estate_collateral_disclosure",
  "org_chart_beneficial_ownership",
  "equipment_list",
  // BF_SERVER_BLOCK_v700_ADVISORS_DOCTYPE_v1 — Accord Professional Advisors form
  "professional_advisors",
] as const;

export type RequiredDocumentKey = (typeof REQUIRED_DOCUMENT_KEYS)[number];

export const ALWAYS_REQUIRED_DOCUMENTS: RequiredDocumentKey[] = [
  "bank_statements_6_months",
];

const LEGACY_DOCUMENT_KEY_MAP: Record<string, RequiredDocumentKey> = {
  bank_statement: "bank_statements_6_months",
  bank_statements: "bank_statements_6_months",
  bank_statements_6_months: "bank_statements_6_months",
  id_document: "government_id",
  government_id: "government_id",
  void_check: "void_cheque",
  void_cheque: "void_cheque",
  articles_of_incorporation: "articles_of_incorporation",
  business_license: "business_license",
  personal_net_worth: "personal_net_worth",
  equipment_quote: "equipment_quote",
  equipment_invoice: "equipment_invoice",
  purchase_order: "purchase_order",
  accounts_receivable_aging: "accounts_receivable_aging",
  accounts_payable_aging: "accounts_payable_aging",
  tax_return: "tax_returns",
  tax_returns: "tax_returns",
  balance_sheet: "financial_statements",
  financial_statements: "financial_statements",
  lease_agreement: "lease_agreement",
  real_estate_schedule: "real_estate_schedule",
  // BF_SERVER_BLOCK_v303_COLLATERAL_DOCTYPES_v1 — Accord LOC doc types (self-map)
  flinks_banking: "flinks_banking",
  cra_view_only_authorization: "cra_view_only_authorization",
  real_estate_collateral_disclosure: "real_estate_collateral_disclosure",
  org_chart_beneficial_ownership: "org_chart_beneficial_ownership",
  equipment_list: "equipment_list",
  // BF_SERVER_BLOCK_v700_ADVISORS_DOCTYPE_v1
  professional_advisors: "professional_advisors",
  // Bridge the BF-portal creator's existing doc-type strings to canonical keys
  // so Accord requirements configured with these normalize instead of dropping.
  net_worth_statement: "personal_net_worth",
  accountant_prepared_financials: "financial_statements",
};

const DOCUMENT_TYPE_ALIASES: Record<RequiredDocumentKey, string[]> = {
  bank_statements_6_months: [
    "bank_statement",
    "bank_statements",
    "bank_statements_6_months",
  ],
  government_id: ["id_document", "government_id"],
  void_cheque: ["void_check", "void_cheque"],
  articles_of_incorporation: ["articles_of_incorporation"],
  business_license: ["business_license"],
  personal_net_worth: ["personal_net_worth"],
  equipment_quote: ["equipment_quote"],
  equipment_invoice: ["equipment_invoice"],
  purchase_order: ["purchase_order"],
  accounts_receivable_aging: ["accounts_receivable_aging"],
  accounts_payable_aging: ["accounts_payable_aging"],
  tax_returns: ["tax_return", "tax_returns"],
  financial_statements: ["balance_sheet", "financial_statements"],
  lease_agreement: ["lease_agreement"],
  real_estate_schedule: ["real_estate_schedule"],
  // BF_SERVER_BLOCK_v303_COLLATERAL_DOCTYPES_v1 — Accord LOC doc types
  flinks_banking: ["flinks_banking"],
  cra_view_only_authorization: ["cra_view_only_authorization"],
  real_estate_collateral_disclosure: ["real_estate_collateral_disclosure"],
  org_chart_beneficial_ownership: ["org_chart_beneficial_ownership"],
  equipment_list: ["equipment_list"],
  // BF_SERVER_BLOCK_v700_ADVISORS_DOCTYPE_v1
  professional_advisors: ["professional_advisors"],
};

export function normalizeRequiredDocumentKey(
  value: string
): RequiredDocumentKey | null {
  const normalized = value.trim().toLowerCase();
  return LEGACY_DOCUMENT_KEY_MAP[normalized] ?? null;
}

export function isRequiredDocumentKey(value: string): value is RequiredDocumentKey {
  return Boolean(normalizeRequiredDocumentKey(value));
}

export function fetchDocumentTypeAliases(
  value: RequiredDocumentKey
): string[] {
  return DOCUMENT_TYPE_ALIASES[value] ?? [value];
}
