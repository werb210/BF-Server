"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALWAYS_REQUIRED_DOCUMENTS = exports.REQUIRED_DOCUMENT_KEYS = void 0;
exports.normalizeRequiredDocumentKey = normalizeRequiredDocumentKey;
exports.isRequiredDocumentKey = isRequiredDocumentKey;
exports.fetchDocumentTypeAliases = fetchDocumentTypeAliases;
exports.REQUIRED_DOCUMENT_KEYS = [
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
];
exports.ALWAYS_REQUIRED_DOCUMENTS = [
    "bank_statements_6_months",
];
const LEGACY_DOCUMENT_KEY_MAP = {
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
};
const DOCUMENT_TYPE_ALIASES = {
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
};
function normalizeRequiredDocumentKey(value) {
    const normalized = value.trim().toLowerCase();
    return LEGACY_DOCUMENT_KEY_MAP[normalized] ?? null;
}
function isRequiredDocumentKey(value) {
    return Boolean(normalizeRequiredDocumentKey(value));
}
function fetchDocumentTypeAliases(value) {
    return DOCUMENT_TYPE_ALIASES[value] ?? [value];
}
