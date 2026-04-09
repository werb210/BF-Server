import {
  type LenderProductCategory,
  type LenderProductRateType,
  type LenderProductTermUnit,
  type RequiredDocuments,
} from "../db/schema/lenderProducts.js";

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
  active: boolean;
  required_documents: RequiredDocuments;
  created_at: Date;
  updated_at: Date;
};
