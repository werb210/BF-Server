// BF_SERVER_BLOCK_v195_OCR_FIELD_REGISTRY_EXPANSION_v1
// Full registry rewrite to cover all 7 categories from OCR_Fields.xlsx:
// Balance Sheet, Income Statement, Cash Flow, Taxes, Contracts, Invoices, Application.
// Field labels and category assignments are sourced verbatim from the spreadsheet.
// Where the spreadsheet places a single field in multiple columns (e.g. Net Income
// appears in Balance Sheet, Income Statement, AND Cash Flow), applies_to is a
// multi-category list. Existing field_keys (business_name, tax_id, owner_name,
// business_address, total_revenue, net_income, cash_on_hand, accounts_receivable,
// accounts_payable, inventory_value, equipment_value, contract_term) are preserved
// — only their applies_to and aliases were extended — so all current consumers of
// fetchOcrFieldDefinitionByKey/Label keep working.

export type OcrDocumentCategory =
  | "balance_sheet"
  | "income_statement"
  | "cash_flow"
  | "taxes"
  | "contracts"
  | "invoices"
  | "application"
  | "ar"
  | "ap"
  | "inventory"
  | "equipment"
  | "general";

export type OcrFieldDefinition = {
  field_key: string;
  display_label: string;
  applies_to: "all" | OcrDocumentCategory[];
  required: boolean;
  aliases?: string[];
};

export const OCR_FIELD_REGISTRY: OcrFieldDefinition[] = [
  // -------- CROSS-DOCUMENT IDENTITY --------
  { field_key: "business_name", display_label: "Business Name", applies_to: "all", required: true, aliases: ["Company Name", "Legal Business Name", "Company name - Legal", "Legal Name"] },
  { field_key: "owner_name", display_label: "Owner Name", applies_to: "all", required: true, aliases: ["Owner", "Principal Name", "Name", "Applicant Name"] },
  { field_key: "business_address", display_label: "Business Address", applies_to: "all", required: false, aliases: ["Company Address", "Mailing Address", "Full address"] },

  // -------- BALANCE SHEET --------
  { field_key: "current_assets", display_label: "Current Assets", applies_to: ["balance_sheet"], required: false },
  { field_key: "cash_on_hand", display_label: "Cash on Hand", applies_to: ["balance_sheet"], required: false, aliases: ["Cash", "Cash Balance", "Cash and cash equivalents", "Cash and Cash Equivalents"] },
  { field_key: "accounts_receivable", display_label: "Accounts Receivable", applies_to: ["ar", "balance_sheet"], required: false, aliases: ["A/R", "Receivables", "Accounts receivables", "accounts reveivables"] },
  { field_key: "inventory_value", display_label: "Inventory Value", applies_to: ["inventory", "balance_sheet"], required: false, aliases: ["Inventory", "Inventory Cost"] },
  { field_key: "other_current_assets", display_label: "Other Current Assets", applies_to: ["balance_sheet"], required: false },
  { field_key: "total_current_assets", display_label: "Total Current Assets", applies_to: ["balance_sheet"], required: false },
  { field_key: "computer_office_equipment", display_label: "Computer and Office Equipment", applies_to: ["balance_sheet"], required: false, aliases: ["Computer and Office Equip"] },
  { field_key: "equipment_value", display_label: "Equipment Value", applies_to: ["equipment", "balance_sheet"], required: false, aliases: ["Equipment", "Equipment Cost"] },
  { field_key: "other_fixed_assets", display_label: "Other Fixed Assets", applies_to: ["balance_sheet"], required: false },
  { field_key: "total_fixed_assets", display_label: "Total Fixed Assets", applies_to: ["balance_sheet"], required: false },
  { field_key: "accounts_payable", display_label: "Accounts Payable", applies_to: ["ap", "balance_sheet"], required: false, aliases: ["A/P", "Payables", "Total Accounts payable"] },
  { field_key: "credit_cards", display_label: "Credit Cards", applies_to: ["balance_sheet"], required: false },
  { field_key: "payroll_liability", display_label: "Payroll", applies_to: ["balance_sheet"], required: false },
  { field_key: "other_accounts_payable", display_label: "Other Accounts Payable", applies_to: ["balance_sheet"], required: false },
  { field_key: "total_other_current_liabilities", display_label: "Total Other Current Liabilities", applies_to: ["balance_sheet"], required: false },
  { field_key: "long_term_liabilities", display_label: "Long Term Liabilities", applies_to: ["balance_sheet"], required: false },
  { field_key: "total_liabilities", display_label: "Total Liabilities", applies_to: ["balance_sheet", "taxes"], required: false },
  { field_key: "retained_earnings", display_label: "Retained Earnings", applies_to: ["balance_sheet"], required: false },
  { field_key: "net_income", display_label: "Net Income", applies_to: ["income_statement", "balance_sheet", "cash_flow"], required: false, aliases: ["Net Profit"] },
  { field_key: "total_equity", display_label: "Total Equity", applies_to: ["balance_sheet"], required: false },
  { field_key: "total_liabilities_and_equity", display_label: "Total Liabilities and Equity", applies_to: ["balance_sheet"], required: false },
  { field_key: "liability_vehicle_types", display_label: "Types (Vehicles) of Liabilities", applies_to: ["balance_sheet"], required: false },
  { field_key: "prepaid_expenses", display_label: "Prepaid Expenses", applies_to: ["balance_sheet"], required: false },
  { field_key: "deferred_tax", display_label: "Deferred Tax Assets/Liabilities", applies_to: ["balance_sheet"], required: false },
  { field_key: "accrued_liabilities", display_label: "Accrued Liabilities", applies_to: ["balance_sheet"], required: false },
  { field_key: "goodwill", display_label: "Goodwill", applies_to: ["balance_sheet"], required: false },
  { field_key: "accumulated_depreciation", display_label: "Accumulated Depreciation", applies_to: ["balance_sheet"], required: false },

  // -------- INCOME STATEMENT --------
  { field_key: "total_revenue", display_label: "Total Revenue", applies_to: ["income_statement"], required: false, aliases: ["Revenue", "Gross Revenue", "Sales", "Income"] },
  { field_key: "salaries", display_label: "Salaries", applies_to: ["income_statement"], required: false },
  { field_key: "materials_cost", display_label: "Materials", applies_to: ["income_statement"], required: false },
  { field_key: "subcontractors_cost", display_label: "Subcontractors", applies_to: ["income_statement"], required: false },
  { field_key: "total_cogs", display_label: "Total COGS", applies_to: ["income_statement"], required: false, aliases: ["Cost of Goods Sold"] },
  { field_key: "general_admin_costs", display_label: "General and Admin Costs", applies_to: ["income_statement"], required: false, aliases: ["G&A"] },
  { field_key: "loan_interest_expense", display_label: "Loan Interests", applies_to: ["income_statement"], required: false, aliases: ["Interest Expense"] },
  { field_key: "sales_marketing_expenses", display_label: "Sales and Marketing Expenses", applies_to: ["income_statement"], required: false },
  { field_key: "warranty_liability", display_label: "Warranty Liability", applies_to: ["income_statement"], required: false },
  { field_key: "indirect_expenses", display_label: "Indirect Expenses", applies_to: ["income_statement"], required: false },
  { field_key: "total_overhead", display_label: "Total Overhead", applies_to: ["income_statement"], required: false },
  { field_key: "depreciation_and_amortization", display_label: "Depreciation and Amortization", applies_to: ["income_statement", "cash_flow"], required: false, aliases: ["D&A"] },
  { field_key: "tax_expense", display_label: "Taxes (P&L)", applies_to: ["income_statement"], required: false },
  { field_key: "interest_income", display_label: "Interest Income", applies_to: ["income_statement"], required: false },
  { field_key: "research_development_costs", display_label: "Research and Development Costs", applies_to: ["income_statement"], required: false, aliases: ["R&D"] },
  { field_key: "extraordinary_gains_losses", display_label: "Extraordinary Gains or Losses", applies_to: ["income_statement"], required: false },

  // -------- CASH FLOW STATEMENT --------
  { field_key: "change_in_accounts_receivable", display_label: "Change in Accounts Receivable", applies_to: ["cash_flow"], required: false },
  { field_key: "change_in_inventory", display_label: "Change in Inventory", applies_to: ["cash_flow"], required: false },
  { field_key: "change_in_accounts_payable", display_label: "Change in Accounts Payable", applies_to: ["cash_flow"], required: false },
  { field_key: "change_in_other_operating_assets_liabilities", display_label: "Change in Other Operating Assets/Liabilities", applies_to: ["cash_flow"], required: false },
  { field_key: "cash_flow_from_operating", display_label: "Cash Flow from Operating Activities", applies_to: ["cash_flow"], required: false },
  { field_key: "capex", display_label: "Purchases of Property, Plant, and Equipment", applies_to: ["cash_flow"], required: false, aliases: ["CapEx", "Capital Expenditures"] },
  { field_key: "proceeds_sale_of_assets", display_label: "Proceeds from Sale of Assets", applies_to: ["cash_flow"], required: false },
  { field_key: "purchase_sale_investments", display_label: "Purchase/Sale of Investments", applies_to: ["cash_flow"], required: false },
  { field_key: "cash_flow_from_investing", display_label: "Cash Flow from Investing Activities", applies_to: ["cash_flow"], required: false },
  { field_key: "proceeds_issuance_debt", display_label: "Proceeds from Issuance of Debt", applies_to: ["cash_flow"], required: false },
  { field_key: "repayment_of_debt", display_label: "Repayment of Debt", applies_to: ["cash_flow"], required: false },
  { field_key: "proceeds_issuance_equity", display_label: "Proceeds from Issuance of Equity", applies_to: ["cash_flow"], required: false },
  { field_key: "dividends_paid", display_label: "Dividends Paid", applies_to: ["cash_flow"], required: false },
  { field_key: "cash_flow_from_financing", display_label: "Cash Flow from Financing Activities", applies_to: ["cash_flow"], required: false },
  { field_key: "net_change_in_cash", display_label: "Net Change in Cash", applies_to: ["cash_flow"], required: false },
  { field_key: "beginning_cash_balance", display_label: "Beginning Cash Balance", applies_to: ["cash_flow"], required: false },
  { field_key: "ending_cash_balance", display_label: "Ending Cash Balance", applies_to: ["cash_flow"], required: false },

  // -------- TAXES --------
  { field_key: "tax_id", display_label: "Tax ID", applies_to: ["taxes"], required: true, aliases: ["EIN", "Employer Identification Number"] },
  { field_key: "business_number", display_label: "Business Number", applies_to: ["taxes"], required: false, aliases: ["BN", "CRA Business Number"] },
  { field_key: "corporation_name", display_label: "Corporation Name", applies_to: ["taxes"], required: false },
  { field_key: "tax_year", display_label: "Tax Year", applies_to: ["taxes"], required: false, aliases: ["Year of Assessment", "Fiscal Year"] },
  { field_key: "taxable_income", display_label: "Taxable Income", applies_to: ["taxes"], required: false },
  { field_key: "total_assets", display_label: "Total Assets", applies_to: ["taxes", "balance_sheet"], required: false },
  { field_key: "key_parties", display_label: "Key Parties", applies_to: ["taxes"], required: false },

  // -------- CONTRACTS --------
  { field_key: "contract_executed_date", display_label: "Executed Date", applies_to: ["contracts"], required: false, aliases: ["Effective Date", "Signing Date"] },
  { field_key: "contract_completion_date", display_label: "Completion Date", applies_to: ["contracts"], required: false },
  { field_key: "general_contractor", display_label: "General Contractor", applies_to: ["contracts", "invoices"], required: false, aliases: ["GC"] },
  { field_key: "subcontractor", display_label: "Subcontractor", applies_to: ["contracts", "invoices"], required: false },
  { field_key: "contract_value", display_label: "Contract Value", applies_to: ["contracts"], required: false },
  { field_key: "holdback_percent", display_label: "Holdback %", applies_to: ["contracts"], required: false },
  { field_key: "contract_additional_key_dates", display_label: "Additional Key Dates", applies_to: ["contracts"], required: false },
  { field_key: "contract_term", display_label: "Contract Term", applies_to: ["contracts"], required: false, aliases: ["Term Length", "Agreement Term"] },

  // -------- INVOICES --------
  { field_key: "invoice_date", display_label: "Invoice Date", applies_to: ["invoices"], required: false, aliases: ["Date"] },
  { field_key: "invoice_subtotal", display_label: "Subtotal", applies_to: ["invoices"], required: false },
  { field_key: "invoice_tax", display_label: "Tax", applies_to: ["invoices"], required: false, aliases: ["GST", "HST", "Sales Tax"] },
  { field_key: "invoice_total", display_label: "Total", applies_to: ["invoices"], required: false, aliases: ["Total Due", "Amount Due"] },
  { field_key: "invoice_terms", display_label: "Terms", applies_to: ["invoices"], required: false, aliases: ["Payment Terms", "Net Terms"] },

  // -------- APPLICATION --------
  { field_key: "ownership_percent", display_label: "Percent of Ownership", applies_to: ["application"], required: false, aliases: ["% Ownership", "Ownership %"] },
  { field_key: "applicant_mobile", display_label: "Mobile", applies_to: ["application"], required: false, aliases: ["Mobile Phone", "Cell"] },
  { field_key: "applicant_title", display_label: "Title", applies_to: ["application"], required: false, aliases: ["Job Title", "Position"] },
  { field_key: "sin", display_label: "SIN", applies_to: ["application"], required: false, aliases: ["SSN", "Social Insurance Number", "Social Security Number"] },
  { field_key: "applicant_email", display_label: "Email", applies_to: ["application"], required: false, aliases: ["Email Address"] },
  { field_key: "applicant_birthdate", display_label: "Birthdate", applies_to: ["application"], required: false, aliases: ["Date of Birth", "DOB"] },
  { field_key: "applicant_home_phone", display_label: "Home Phone", applies_to: ["application"], required: false },
  { field_key: "applicant_home_address", display_label: "Full Home Address", applies_to: ["application"], required: false, aliases: ["Home Address", "Residential Address", "full home address"] },
  { field_key: "rent_or_own", display_label: "Rent or Own", applies_to: ["application"], required: false, aliases: ["Do they rent or own", "Housing Status"] },
  { field_key: "property_value", display_label: "Property Value", applies_to: ["application"], required: false },
  { field_key: "mortgage_balance", display_label: "Mortgage Balance", applies_to: ["application"], required: false },
  { field_key: "industry", display_label: "Industry", applies_to: ["application"], required: false, aliases: ["NAICS", "Sector"] },
  { field_key: "website_url", display_label: "Website URL", applies_to: ["application"], required: false, aliases: ["Website", "URL"] },
  { field_key: "company_start_date", display_label: "Company Start Date", applies_to: ["application"], required: false, aliases: ["Date of Incorporation", "Founded"] },
  { field_key: "employee_count", display_label: "Number of Employees", applies_to: ["application"], required: false, aliases: ["Headcount", "Staff Count"] },
  { field_key: "monthly_rent_or_mortgage", display_label: "Monthly Rent/Mortgage", applies_to: ["application"], required: false, aliases: ["Rent/mortgage", "Housing Payment"] },
  { field_key: "registration_number", display_label: "Registration Number", applies_to: ["application"], required: false, aliases: ["Registration", "Corporate Registration"] },
  { field_key: "company_name_dba", display_label: "Company Name - DBA", applies_to: ["application"], required: false, aliases: ["DBA", "Doing Business As", "Trade Name"] },
  { field_key: "company_phone", display_label: "Company Phone", applies_to: ["application"], required: false, aliases: ["Company phone #", "Business Phone"] },
  { field_key: "company_fax", display_label: "Company Fax", applies_to: ["application"], required: false, aliases: ["Company Fax #", "Business Fax"] },
];

export function fetchOcrFieldRegistry(): OcrFieldDefinition[] {
  return [...OCR_FIELD_REGISTRY];
}

export function fetchOcrFieldDefinitionByKey(
  key: string
): OcrFieldDefinition | undefined {
  return OCR_FIELD_REGISTRY.find((field) => field.field_key === key);
}

export function fetchOcrFieldDefinitionByLabel(
  label: string
): OcrFieldDefinition | undefined {
  const normalized = label.trim().toLowerCase();
  return OCR_FIELD_REGISTRY.find((field) => {
    if (field.display_label.trim().toLowerCase() === normalized) {
      return true;
    }
    return (field.aliases ?? []).some(
      (alias) => alias.trim().toLowerCase() === normalized
    );
  });
}
