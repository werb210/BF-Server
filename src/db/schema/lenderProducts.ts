export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;

export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type RequiredDocuments = JsonObject[];
export type Eligibility = JsonObject | null;

// BF_SERVER_BLOCK_v81_CATEGORIES_COMPANION — full 10-category set.
// Always-visible: LOC, TERM, EQUIPMENT, FACTORING, PO, MCA, MEDIA.
// Conditional (UI hides until ≥1 active product exists): ABL, SBA, STARTUP.
export const LENDER_PRODUCT_CATEGORIES = [
  "LOC",
  "TERM",
  "FACTORING",
  "PO",
  "EQUIPMENT",
  "MCA",
  "MEDIA",
  "ABL",
  "SBA",
  "STARTUP",
] as const;

export const LENDER_PRODUCT_RATE_TYPES = ["FIXED", "VARIABLE"] as const;

export const LENDER_PRODUCT_TERM_UNITS = ["MONTHS"] as const;

export type LenderProductCategory = (typeof LENDER_PRODUCT_CATEGORIES)[number];
export type LenderProductRateType = (typeof LENDER_PRODUCT_RATE_TYPES)[number];
export type LenderProductTermUnit = (typeof LENDER_PRODUCT_TERM_UNITS)[number];

export type LenderProductRecord = {
  id: string;
  lender_id: string;
  name: string;
  category: LenderProductCategory;
  country: string;
  rate_type: LenderProductRateType | null;
  interest_min: string | null;
  interest_max: string | null;
  term_min: number | null;
  term_max: number | null;
  term_unit: LenderProductTermUnit;
  amount_min?: number | null;
  amount_max?: number | null;
  commission?: number | null;
  min_credit_score?: number | null;
  silo?: string | null;
  active: boolean;
  required_documents: RequiredDocuments;
  created_at: Date;
  updated_at: Date;
};
