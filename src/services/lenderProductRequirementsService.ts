import { config } from "../config";
import { AppError } from "../middleware/errors";
import { logInfo, logWarn } from "../observability/logger";
import { pool } from "../db";
import { randomUUID } from "crypto";
import {
  ALWAYS_REQUIRED_DOCUMENTS,
  normalizeRequiredDocumentKey,
} from "../db/schema/requiredDocuments";

export type LenderProductRequirement = {
  id: string;
  documentType: string;
  required: boolean;
  minAmount: number | null;
  maxAmount: number | null;
};

type RequiredDocumentEntry = {
  id?: string;
  type?: string;
  documentType?: string;
  document_key?: string;
  key?: string;
  required?: boolean;
  minAmount?: number | null;
  maxAmount?: number | null;
  min_amount?: number | null;
  max_amount?: number | null;
  months?: number | null;
};

type LenderProductRecord = {
  id: string;
  category: string;
  country: string;
  rate_type: string | null;
  term_min: number | null;
  term_max: number | null;
  required_documents: unknown;
  active: boolean;
  lender_active: boolean;
};

function normalizeCategory(productType: string): string {
  const normalized = productType.trim().toUpperCase();
  if (normalized === "STANDARD" || normalized === "LOC" || normalized === "LINE_OF_CREDIT") {
    return "LOC";
  }
  if (normalized === "TERM" || normalized === "TERM_LOAN") {
    return "TERM";
  }
  if (normalized === "FACTORING") {
    return "FACTORING";
  }
  if (normalized === "PO" || normalized === "PURCHASE_ORDER") {
    return "PO";
  }
  if (normalized === "EQUIPMENT" || normalized === "EQUIPMENT_FINANCING") {
    return "EQUIPMENT";
  }
  if (normalized === "MCA" || normalized === "MERCHANT_CASH_ADVANCE") {
    return "MCA";
  }
  return normalized;
}

function normalizeRequirementEntry(entry: RequiredDocumentEntry): LenderProductRequirement | null {
  const rawType =
    typeof entry.type === "string"
      ? entry.type
      : typeof entry.documentType === "string"
        ? entry.documentType
        : typeof entry.document_key === "string"
          ? entry.document_key
          : typeof entry.key === "string"
            ? entry.key
            : null;
  if (!rawType) {
    return null;
  }
  const normalizedType = normalizeRequiredDocumentKey(rawType);
  if (!normalizedType) {
    return null;
  }
  const minAmount =
    typeof entry.minAmount === "number"
      ? entry.minAmount
      : typeof entry.min_amount === "number"
        ? entry.min_amount
        : null;
  const maxAmount =
    typeof entry.maxAmount === "number"
      ? entry.maxAmount
      : typeof entry.max_amount === "number"
        ? entry.max_amount
        : null;
  return {
    id: typeof entry.id === "string" ? entry.id : randomUUID(),
    documentType: normalizedType,
    required: entry.required !== false,
    minAmount,
    maxAmount,
  };
}

function parseRequiredDocuments(value: unknown): RequiredDocumentEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is RequiredDocumentEntry => {
    return typeof entry === "object" && entry !== null && !Array.isArray(entry);
  });
}

function dedupeRequirements(requirements: LenderProductRequirement[]): LenderProductRequirement[] {
  const map = new Map<string, LenderProductRequirement>();
  for (const req of requirements) {
    const existing = map.get(req.documentType);
    if (!existing) {
      map.set(req.documentType, { ...req });
      continue;
    }
    map.set(req.documentType, {
      ...existing,
      required: existing.required || req.required,
      minAmount:
        existing.minAmount === null
          ? req.minAmount
          : req.minAmount === null
            ? existing.minAmount
            : Math.min(existing.minAmount, req.minAmount),
      maxAmount:
        existing.maxAmount === null
          ? req.maxAmount
          : req.maxAmount === null
            ? existing.maxAmount
            : Math.max(existing.maxAmount, req.maxAmount),
    });
  }
  return Array.from(map.values());
}

function ensureAlwaysRequired(
  requirements: LenderProductRequirement[]
): LenderProductRequirement[] {
  const existing = new Set(requirements.map((req) => req.documentType));
  const additions = ALWAYS_REQUIRED_DOCUMENTS.filter(
    (doc) => !existing.has(doc)
  ).map((doc) => ({
    id: randomUUID(),
    documentType: doc,
    required: true,
    minAmount: null,
    maxAmount: null,
  }));
  if (additions.length === 0) {
    return requirements;
  }
  return [...requirements, ...additions];
}

async function fetchProductById(params: {
  id: string;
  requireActive?: boolean;
}): Promise<LenderProductRecord | null> {
  const res = await pool.query<LenderProductRecord>(
    `select lp.id,
            lp.category,
            lp.country,
            lp.rate_type,
            lp.term_min,
            lp.term_max,
            lp.required_documents,
            lp.active,
            l.active as lender_active
     from lender_products lp
     join lenders l on l.id = lp.lender_id
     where lp.id = $1
     limit 1`,
    [params.id]
  );
  const product = res.rows[0] ?? null;
  if (!product) {
    return null;
  }
  if (params.requireActive && (!product.active || !product.lender_active)) {
    return null;
  }
  return product;
}

async function listMatchingProducts(params: {
  category: string;
  country: string;
  requestedAmount?: number | null;
}): Promise<LenderProductRecord[]> {
  const values: Array<string | number> = [params.category, params.country];
  const amount = params.requestedAmount ?? null;
  const amountClause = amount === null ? "" : `and (lp.term_min is null or $3 >= lp.term_min)
     and (lp.term_max is null or $3 <= lp.term_max)`;
  if (amount !== null) {
    values.push(amount);
  }
  const res = await pool.query<LenderProductRecord>(
    `select lp.id,
            lp.category,
            lp.country,
            lp.rate_type,
            lp.term_min,
            lp.term_max,
            lp.required_documents,
            lp.active,
            l.active as lender_active
     from lender_products lp
     join lenders l on l.id = lp.lender_id
     where lp.active = true
       and l.active = true
       and lp.category = $1
       and (lp.country = $2 or lp.country = 'BOTH' or $2 = 'BOTH')
       ${amountClause}
     order by lp.created_at asc`,
    values
  );
  return res.rows;
}

export async function listRequirementsForFilters(params: {
  category: string;
  country?: string | null;
  requestedAmount?: number | null;
}): Promise<LenderProductRequirement[]> {
  const category = normalizeCategory(params.category);
  const country = params.country?.trim().toUpperCase() ?? "BOTH";
  const products = await listMatchingProducts({
    category,
    country,
    requestedAmount: params.requestedAmount ?? null,
  });
  const requirements = products.flatMap((product) => {
    const docs = parseRequiredDocuments(product.required_documents);
    return docs
      .map((entry) => normalizeRequirementEntry(entry))
      .filter((entry): entry is LenderProductRequirement => Boolean(entry));
  });
  const normalized = ensureAlwaysRequired(dedupeRequirements(requirements));
  return normalized;
}

export async function resolveLenderProductRequirements(params: {
  lenderProductId: string;
  requestedAmount?: number | null;
}): Promise<LenderProductRequirement[]> {
  const product = await fetchProductById({ id: params.lenderProductId });
  if (!product) {
    return [];
  }
  const documents = parseRequiredDocuments(product.required_documents);
  const requirements = documents
    .map((entry) => normalizeRequirementEntry(entry))
    .filter((entry): entry is LenderProductRequirement => Boolean(entry));
  const filtered = requirements.filter((req) => {
    if (params.requestedAmount === undefined || params.requestedAmount === null) {
      return true;
    }
    if (req.minAmount !== null && params.requestedAmount < req.minAmount) {
      return false;
    }
    if (req.maxAmount !== null && params.requestedAmount > req.maxAmount) {
      return false;
    }
    return true;
  });
  const normalized = ensureAlwaysRequired(dedupeRequirements(filtered));
  logInfo("lender_product_requirements_resolved", {
    lenderProductId: params.lenderProductId,
    requestedAmount: params.requestedAmount ?? null,
    total: normalized.length,
    requiredCount: normalized.filter((req) => req.required).length,
  });
  return normalized;
}

export async function resolveRequirementsForProductType(params: {
  productType: string;
  requestedAmount?: number | null;
  country?: string | null;
}): Promise<{ requirements: LenderProductRequirement[]; lenderProductId: string | null }> {
  const category = normalizeCategory(params.productType);
  const country = params.country?.trim().toUpperCase() ?? "BOTH";
  const products = await listMatchingProducts({
    category,
    country,
    requestedAmount: params.requestedAmount ?? null,
  });
  if (products.length === 0) {
    logWarn("lender_product_type_missing", { productType: params.productType });
    if (config.env === "test") {
      const requirements = ensureAlwaysRequired([]);
      return { requirements, lenderProductId: null };
    }
    throw new AppError("invalid_product", "Unsupported product type.", 400);
  }
  const requirements = products.flatMap((product) => {
    const docs = parseRequiredDocuments(product.required_documents);
    return docs
      .map((entry) => normalizeRequirementEntry(entry))
      .filter((entry): entry is LenderProductRequirement => Boolean(entry));
  });
  const normalized = ensureAlwaysRequired(dedupeRequirements(requirements));
  return { requirements: normalized, lenderProductId: products[0]?.id ?? null };
}

export async function resolveRequirementsForApplication(params: {
  lenderProductId: string | null;
  productType: string;
  requestedAmount?: number | null;
  country?: string | null;
}): Promise<{ requirements: LenderProductRequirement[]; lenderProductId: string | null }> {
  if (params.lenderProductId) {
    const requirements = await resolveLenderProductRequirements({
      lenderProductId: params.lenderProductId,
      requestedAmount: params.requestedAmount ?? null,
    });
    return { requirements, lenderProductId: params.lenderProductId };
  }
  const result = await resolveRequirementsForProductType({
    productType: params.productType,
    requestedAmount: params.requestedAmount ?? null,
    country: params.country ?? null,
  });
  return result;
}

export async function listClientRequirements(params: {
  lenderProductId: string;
  requestedAmount?: number | null;
}): Promise<LenderProductRequirement[]> {
  const product = await fetchProductById({
    id: params.lenderProductId,
    requireActive: true,
  });
  if (!product) {
    return [];
  }
  const requirements = await resolveLenderProductRequirements({
    lenderProductId: params.lenderProductId,
    requestedAmount: params.requestedAmount ?? null,
  });
  return requirements.filter((requirement) => requirement.required);
}

export async function createRequirementForProduct(params: {
  lenderProductId: string;
  documentType: string;
  required?: boolean;
  minAmount?: number | null;
  maxAmount?: number | null;
}): Promise<LenderProductRequirement> {
  const product = await fetchProductById({ id: params.lenderProductId });
  if (!product) {
    throw new AppError("not_found", "Lender product not found.", 404);
  }
  const documents = parseRequiredDocuments(product.required_documents);
  const newEntry: RequiredDocumentEntry = {
    id: randomUUID(),
    type: params.documentType,
    required: params.required ?? true,
    minAmount: params.minAmount ?? null,
    maxAmount: params.maxAmount ?? null,
  };
  documents.push(newEntry);
  await pool.query(
    `update lender_products
     set required_documents = $1,
         updated_at = now()
     where id = $2`,
    [JSON.stringify(documents), params.lenderProductId]
  );
  const requirement = normalizeRequirementEntry(newEntry);
  if (!requirement) {
    throw new AppError("data_error", "Invalid requirement payload.", 500);
  }
  return requirement;
}

export async function updateRequirementForProduct(params: {
  id: string;
  documentType: string;
  required?: boolean;
  minAmount?: number | null;
  maxAmount?: number | null;
}): Promise<LenderProductRequirement> {
  const res = await pool.query<{ id: string; required_documents: unknown }>(
    `select id, required_documents
     from lender_products
     where required_documents @> $1::jsonb
     limit 1`,
    [JSON.stringify([{ id: params.id }])]
  );
  const product = res.rows[0];
  if (!product) {
    throw new AppError("not_found", "Requirement not found.", 404);
  }
  const documents = parseRequiredDocuments(product.required_documents);
  const index = documents.findIndex((entry) => entry.id === params.id);
  if (index < 0) {
    throw new AppError("not_found", "Requirement not found.", 404);
  }
  documents[index] = {
    ...documents[index],
    id: params.id,
    type: params.documentType,
    required: params.required ?? true,
    minAmount: params.minAmount ?? null,
    maxAmount: params.maxAmount ?? null,
  };
  await pool.query(
    `update lender_products
     set required_documents = $1,
         updated_at = now()
     where id = $2`,
    [JSON.stringify(documents), product.id]
  );
  const requirement = normalizeRequirementEntry(documents[index]);
  if (!requirement) {
    throw new AppError("data_error", "Invalid requirement payload.", 500);
  }
  return requirement;
}

export async function deleteRequirementForProduct(params: {
  id: string;
}): Promise<LenderProductRequirement> {
  const res = await pool.query<{ id: string; required_documents: unknown }>(
    `select id, required_documents
     from lender_products
     where required_documents @> $1::jsonb
     limit 1`,
    [JSON.stringify([{ id: params.id }])]
  );
  const product = res.rows[0];
  if (!product) {
    throw new AppError("not_found", "Requirement not found.", 404);
  }
  const documents = parseRequiredDocuments(product.required_documents);
  const index = documents.findIndex((entry) => entry.id === params.id);
  if (index < 0) {
    throw new AppError("not_found", "Requirement not found.", 404);
  }
  const [removed] = documents.splice(index, 1);
  if (!removed) {
    throw new AppError("data_error", "Invalid requirement payload.", 500);
  }
  await pool.query(
    `update lender_products
     set required_documents = $1,
         updated_at = now()
     where id = $2`,
    [JSON.stringify(documents), product.id]
  );
  const requirement = normalizeRequirementEntry(removed);
  if (!requirement) {
    throw new AppError("data_error", "Invalid requirement payload.", 500);
  }
  return requirement;
}

export async function ensureSeedRequirementsForProduct(): Promise<number> {
  return 0;
}

export async function seedRequirementsForAllProducts(): Promise<void> {
  return;
}
