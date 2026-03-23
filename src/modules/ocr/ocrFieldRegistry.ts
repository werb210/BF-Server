export type OcrDocumentCategory =
  | "balance_sheet"
  | "income_statement"
  | "cash_flow"
  | "taxes"
  | "ar"
  | "ap"
  | "inventory"
  | "equipment"
  | "contracts"
  | "general";

export type OcrFieldDefinition = {
  field_key: string;
  display_label: string;
  applies_to: "all" | OcrDocumentCategory[];
  required: boolean;
  aliases?: string[];
};

export const OCR_FIELD_REGISTRY: OcrFieldDefinition[] = [
  {
    field_key: "business_name",
    display_label: "Business Name",
    applies_to: "all",
    required: true,
    aliases: ["Company Name", "Legal Business Name"],
  },
  {
    field_key: "tax_id",
    display_label: "Tax ID",
    applies_to: ["taxes"],
    required: true,
    aliases: ["EIN", "Employer Identification Number"],
  },
  {
    field_key: "owner_name",
    display_label: "Owner Name",
    applies_to: "all",
    required: true,
    aliases: ["Owner", "Principal Name"],
  },
  {
    field_key: "business_address",
    display_label: "Business Address",
    applies_to: "all",
    required: false,
    aliases: ["Company Address", "Mailing Address"],
  },
  {
    field_key: "total_revenue",
    display_label: "Total Revenue",
    applies_to: ["income_statement"],
    required: false,
    aliases: ["Revenue", "Gross Revenue", "Sales"],
  },
  {
    field_key: "net_income",
    display_label: "Net Income",
    applies_to: ["income_statement"],
    required: false,
    aliases: ["Net Profit"],
  },
  {
    field_key: "cash_on_hand",
    display_label: "Cash on Hand",
    applies_to: ["balance_sheet"],
    required: false,
    aliases: ["Cash", "Cash Balance"],
  },
  {
    field_key: "accounts_receivable",
    display_label: "Accounts Receivable",
    applies_to: ["ar"],
    required: false,
    aliases: ["A/R", "Receivables"],
  },
  {
    field_key: "accounts_payable",
    display_label: "Accounts Payable",
    applies_to: ["ap"],
    required: false,
    aliases: ["A/P", "Payables"],
  },
  {
    field_key: "inventory_value",
    display_label: "Inventory Value",
    applies_to: ["inventory"],
    required: false,
    aliases: ["Inventory", "Inventory Cost"],
  },
  {
    field_key: "equipment_value",
    display_label: "Equipment Value",
    applies_to: ["equipment"],
    required: false,
    aliases: ["Equipment", "Equipment Cost"],
  },
  {
    field_key: "contract_term",
    display_label: "Contract Term",
    applies_to: ["contracts"],
    required: false,
    aliases: ["Term Length", "Agreement Term"],
  },
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
