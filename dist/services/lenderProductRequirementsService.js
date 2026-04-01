"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listRequirementsForFilters = listRequirementsForFilters;
exports.resolveLenderProductRequirements = resolveLenderProductRequirements;
exports.resolveRequirementsForProductType = resolveRequirementsForProductType;
exports.resolveRequirementsForApplication = resolveRequirementsForApplication;
exports.listClientRequirements = listClientRequirements;
exports.createRequirementForProduct = createRequirementForProduct;
exports.updateRequirementForProduct = updateRequirementForProduct;
exports.deleteRequirementForProduct = deleteRequirementForProduct;
exports.ensureSeedRequirementsForProduct = ensureSeedRequirementsForProduct;
exports.seedRequirementsForAllProducts = seedRequirementsForAllProducts;
const config_1 = require("../config");
const errors_1 = require("../middleware/errors");
const logger_1 = require("../observability/logger");
const db_1 = require("../db");
const crypto_1 = require("crypto");
const requiredDocuments_1 = require("../db/schema/requiredDocuments");
function normalizeCategory(productType) {
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
function normalizeRequirementEntry(entry) {
    const rawType = typeof entry.type === "string"
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
    const normalizedType = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(rawType);
    if (!normalizedType) {
        return null;
    }
    const minAmount = typeof entry.minAmount === "number"
        ? entry.minAmount
        : typeof entry.min_amount === "number"
            ? entry.min_amount
            : null;
    const maxAmount = typeof entry.maxAmount === "number"
        ? entry.maxAmount
        : typeof entry.max_amount === "number"
            ? entry.max_amount
            : null;
    return {
        id: typeof entry.id === "string" ? entry.id : (0, crypto_1.randomUUID)(),
        documentType: normalizedType,
        required: entry.required !== false,
        minAmount,
        maxAmount,
    };
}
function parseRequiredDocuments(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => {
        return typeof entry === "object" && entry !== null && !Array.isArray(entry);
    });
}
function dedupeRequirements(requirements) {
    const map = new Map();
    for (const req of requirements) {
        const existing = map.get(req.documentType);
        if (!existing) {
            map.set(req.documentType, { ...req });
            continue;
        }
        map.set(req.documentType, {
            ...existing,
            required: existing.required || req.required,
            minAmount: existing.minAmount === null
                ? req.minAmount
                : req.minAmount === null
                    ? existing.minAmount
                    : Math.min(existing.minAmount, req.minAmount),
            maxAmount: existing.maxAmount === null
                ? req.maxAmount
                : req.maxAmount === null
                    ? existing.maxAmount
                    : Math.max(existing.maxAmount, req.maxAmount),
        });
    }
    return Array.from(map.values());
}
function ensureAlwaysRequired(requirements) {
    const existing = new Set(requirements.map((req) => req.documentType));
    const additions = requiredDocuments_1.ALWAYS_REQUIRED_DOCUMENTS.filter((doc) => !existing.has(doc)).map((doc) => ({
        id: (0, crypto_1.randomUUID)(),
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
async function fetchProductById(params) {
    const res = await db_1.pool.runQuery(`select lp.id,
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
     limit 1`, [params.id]);
    const product = res.rows[0] ?? null;
    if (!product) {
        return null;
    }
    if (params.requireActive && (!product.active || !product.lender_active)) {
        return null;
    }
    return product;
}
async function listMatchingProducts(params) {
    const values = [params.category, params.country];
    const amount = params.requestedAmount ?? null;
    const amountClause = amount === null ? "" : `and (lp.term_min is null or $3 >= lp.term_min)
     and (lp.term_max is null or $3 <= lp.term_max)`;
    if (amount !== null) {
        values.push(amount);
    }
    const res = await db_1.pool.runQuery(`select lp.id,
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
     order by lp.created_at asc`, values);
    return res.rows;
}
async function listRequirementsForFilters(params) {
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
            .filter((entry) => Boolean(entry));
    });
    const normalized = ensureAlwaysRequired(dedupeRequirements(requirements));
    return normalized;
}
async function resolveLenderProductRequirements(params) {
    const product = await fetchProductById({ id: params.lenderProductId });
    if (!product) {
        return [];
    }
    const documents = parseRequiredDocuments(product.required_documents);
    const requirements = documents
        .map((entry) => normalizeRequirementEntry(entry))
        .filter((entry) => Boolean(entry));
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
    (0, logger_1.logInfo)("lender_product_requirements_resolved", {
        lenderProductId: params.lenderProductId,
        requestedAmount: params.requestedAmount ?? null,
        total: normalized.length,
        requiredCount: normalized.filter((req) => req.required).length,
    });
    return normalized;
}
async function resolveRequirementsForProductType(params) {
    const category = normalizeCategory(params.productType);
    const country = params.country?.trim().toUpperCase() ?? "BOTH";
    const products = await listMatchingProducts({
        category,
        country,
        requestedAmount: params.requestedAmount ?? null,
    });
    if (products.length === 0) {
        (0, logger_1.logWarn)("lender_product_type_missing", { productType: params.productType });
        if (config_1.config.env === "test") {
            const requirements = ensureAlwaysRequired([]);
            return { requirements, lenderProductId: null };
        }
        throw new errors_1.AppError("invalid_product", "Unsupported product type.", 400);
    }
    const requirements = products.flatMap((product) => {
        const docs = parseRequiredDocuments(product.required_documents);
        return docs
            .map((entry) => normalizeRequirementEntry(entry))
            .filter((entry) => Boolean(entry));
    });
    const normalized = ensureAlwaysRequired(dedupeRequirements(requirements));
    return { requirements: normalized, lenderProductId: products[0]?.id ?? null };
}
async function resolveRequirementsForApplication(params) {
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
async function listClientRequirements(params) {
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
async function createRequirementForProduct(params) {
    const product = await fetchProductById({ id: params.lenderProductId });
    if (!product) {
        throw new errors_1.AppError("not_found", "Lender product not found.", 404);
    }
    const documents = parseRequiredDocuments(product.required_documents);
    const newEntry = {
        id: (0, crypto_1.randomUUID)(),
        type: params.documentType,
        required: params.required ?? true,
        minAmount: params.minAmount ?? null,
        maxAmount: params.maxAmount ?? null,
    };
    documents.push(newEntry);
    await db_1.pool.runQuery(`update lender_products
     set required_documents = $1,
         updated_at = now()
     where id = $2`, [JSON.stringify(documents), params.lenderProductId]);
    const requirement = normalizeRequirementEntry(newEntry);
    if (!requirement) {
        throw new errors_1.AppError("data_error", "Invalid requirement payload.", 500);
    }
    return requirement;
}
async function updateRequirementForProduct(params) {
    const res = await db_1.pool.runQuery(`select id, required_documents
     from lender_products
     where required_documents @> $1::jsonb
     limit 1`, [JSON.stringify([{ id: params.id }])]);
    const product = res.rows[0];
    if (!product) {
        throw new errors_1.AppError("not_found", "Requirement not found.", 404);
    }
    const documents = parseRequiredDocuments(product.required_documents);
    const index = documents.findIndex((entry) => entry.id === params.id);
    if (index < 0) {
        throw new errors_1.AppError("not_found", "Requirement not found.", 404);
    }
    documents[index] = {
        ...documents[index],
        id: params.id,
        type: params.documentType,
        required: params.required ?? true,
        minAmount: params.minAmount ?? null,
        maxAmount: params.maxAmount ?? null,
    };
    await db_1.pool.runQuery(`update lender_products
     set required_documents = $1,
         updated_at = now()
     where id = $2`, [JSON.stringify(documents), product.id]);
    const requirement = normalizeRequirementEntry(documents[index]);
    if (!requirement) {
        throw new errors_1.AppError("data_error", "Invalid requirement payload.", 500);
    }
    return requirement;
}
async function deleteRequirementForProduct(params) {
    const res = await db_1.pool.runQuery(`select id, required_documents
     from lender_products
     where required_documents @> $1::jsonb
     limit 1`, [JSON.stringify([{ id: params.id }])]);
    const product = res.rows[0];
    if (!product) {
        throw new errors_1.AppError("not_found", "Requirement not found.", 404);
    }
    const documents = parseRequiredDocuments(product.required_documents);
    const index = documents.findIndex((entry) => entry.id === params.id);
    if (index < 0) {
        throw new errors_1.AppError("not_found", "Requirement not found.", 404);
    }
    const [removed] = documents.splice(index, 1);
    if (!removed) {
        throw new errors_1.AppError("data_error", "Invalid requirement payload.", 500);
    }
    await db_1.pool.runQuery(`update lender_products
     set required_documents = $1,
         updated_at = now()
     where id = $2`, [JSON.stringify(documents), product.id]);
    const requirement = normalizeRequirementEntry(removed);
    if (!requirement) {
        throw new errors_1.AppError("data_error", "Invalid requirement payload.", 500);
    }
    return requirement;
}
async function ensureSeedRequirementsForProduct() {
    return 0;
}
async function seedRequirementsForAllProducts() {
    return;
}
