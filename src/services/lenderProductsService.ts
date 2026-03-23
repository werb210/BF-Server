import { AppError } from "../middleware/errors";
import {
  createLenderProduct,
  fetchLenderProductById,
  listLenderProducts,
  listLenderProductsByLenderId,
  updateLenderProduct,
} from "../repositories/lenderProducts.repo";
import { type RequiredDocuments } from "../db/schema/lenderProducts";

export const DEFAULT_LENDER_PRODUCT_NAME = "Unnamed Product";
const DEFAULT_SILO = "default";

function normalizeCategory(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized === "STANDARD" || normalized === "LINE_OF_CREDIT") {
    return "LOC";
  }
  if (normalized === "TERM_LOAN") {
    return "TERM";
  }
  if (normalized === "PURCHASE_ORDER") {
    return "PO";
  }
  if (normalized === "EQUIPMENT_FINANCING") {
    return "EQUIPMENT";
  }
  if (normalized === "MERCHANT_CASH_ADVANCE") {
    return "MCA";
  }
  return normalized;
}

function normalizeLenderProductName(value: unknown): string {
  if (value === undefined || value === null) {
    return DEFAULT_LENDER_PRODUCT_NAME;
  }

  if (typeof value !== "string") {
    throw new AppError("validation_error", "name must be a string.", 400);
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? DEFAULT_LENDER_PRODUCT_NAME : trimmed;
}

function resolveSilo(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return DEFAULT_SILO;
}

function filterBySilo<T extends Record<string, unknown>>(
  records: T[],
  silo: string
): T[] {
  return records.filter((record) => {
    const recordSilo = record.silo;
    if (
      recordSilo === undefined ||
      recordSilo === null ||
      (typeof recordSilo === "string" && recordSilo.trim().length === 0)
    ) {
      return true;
    }
    return resolveSilo(recordSilo) === silo;
  });
}

export async function createLenderProductService(params: {
  lenderId: string;
  name: unknown;
  active: boolean;
  category?: unknown;
  requiredDocuments: RequiredDocuments;
  country?: string | null;
  rateType?: string | null;
  interestMin?: number | string | null;
  interestMax?: number | string | null;
  termMin?: number | null;
  termMax?: number | null;
}): Promise<Awaited<ReturnType<typeof createLenderProduct>>> {
  const normalizedName = normalizeLenderProductName(params.name);
  const normalizedCategory =
    typeof params.category === "string" && params.category.trim().length > 0
      ? normalizeCategory(params.category)
      : "LOC";

  const product = await createLenderProduct({
    lenderId: params.lenderId,
    name: normalizedName,
    active: params.active,
    category: normalizedCategory,
    requiredDocuments: params.requiredDocuments,
    country: params.country ?? null,
    rateType: params.rateType ?? null,
    interestMin: params.interestMin ?? null,
    interestMax: params.interestMax ?? null,
    termMin: params.termMin ?? null,
    termMax: params.termMax ?? null,
  });
  return product;
}

export async function listLenderProductsService(params?: {
  silo?: string | null;
}): Promise<Awaited<ReturnType<typeof listLenderProducts>>> {
  const products = await listLenderProducts();
  const resolvedSilo = resolveSilo(params?.silo);
  return filterBySilo(products, resolvedSilo);
}

export async function listLenderProductsByLenderIdService(params: {
  lenderId: string;
  silo?: string | null;
}): Promise<Awaited<ReturnType<typeof listLenderProductsByLenderId>>> {
  const products = await listLenderProductsByLenderId(params.lenderId);
  const resolvedSilo = resolveSilo(params.silo);
  return filterBySilo(products, resolvedSilo);
}

export async function fetchLenderProductByIdService(params: {
  id: string;
}): Promise<Awaited<ReturnType<typeof fetchLenderProductById>>> {
  return fetchLenderProductById(params.id);
}

export async function updateLenderProductService(params: {
  id: string;
  name: unknown;
  requiredDocuments: RequiredDocuments;
  active?: boolean;
  category?: string | null;
  country?: string | null;
  rateType?: string | null;
  interestMin?: number | string | null;
  interestMax?: number | string | null;
  termMin?: number | null;
  termMax?: number | null;
}): Promise<Awaited<ReturnType<typeof updateLenderProduct>>> {
  const normalizedName = normalizeLenderProductName(params.name);

  const updatePayload = {
    id: params.id,
    name: normalizedName,
    requiredDocuments: params.requiredDocuments,
    ...(params.active !== undefined ? { active: params.active } : {}),
    ...(params.category !== undefined ? { category: params.category } : {}),
    ...(params.country !== undefined ? { country: params.country } : {}),
    ...(params.rateType !== undefined ? { rateType: params.rateType } : {}),
    ...(params.interestMin !== undefined ? { interestMin: params.interestMin } : {}),
    ...(params.interestMax !== undefined ? { interestMax: params.interestMax } : {}),
    ...(params.termMin !== undefined ? { termMin: params.termMin } : {}),
    ...(params.termMax !== undefined ? { termMax: params.termMax } : {}),
  };

  return updateLenderProduct(updatePayload);
}
