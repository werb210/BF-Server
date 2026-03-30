"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_LENDER_PRODUCT_NAME = void 0;
exports.createLenderProductService = createLenderProductService;
exports.listLenderProductsService = listLenderProductsService;
exports.listLenderProductsByLenderIdService = listLenderProductsByLenderIdService;
exports.fetchLenderProductByIdService = fetchLenderProductByIdService;
exports.updateLenderProductService = updateLenderProductService;
const errors_1 = require("../middleware/errors");
const lenderProducts_repo_1 = require("../repositories/lenderProducts.repo");
exports.DEFAULT_LENDER_PRODUCT_NAME = "Unnamed Product";
const DEFAULT_SILO = "default";
function normalizeCategory(value) {
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
function normalizeLenderProductName(value) {
    if (value === undefined || value === null) {
        return exports.DEFAULT_LENDER_PRODUCT_NAME;
    }
    if (typeof value !== "string") {
        throw new errors_1.AppError("validation_error", "name must be a string.", 400);
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? exports.DEFAULT_LENDER_PRODUCT_NAME : trimmed;
}
function resolveSilo(value) {
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
    }
    return DEFAULT_SILO;
}
function filterBySilo(records, silo) {
    return records.filter((record) => {
        const recordSilo = record.silo;
        if (recordSilo === undefined ||
            recordSilo === null ||
            (typeof recordSilo === "string" && recordSilo.trim().length === 0)) {
            return true;
        }
        return resolveSilo(recordSilo) === silo;
    });
}
async function createLenderProductService(params) {
    const normalizedName = normalizeLenderProductName(params.name);
    const normalizedCategory = typeof params.category === "string" && params.category.trim().length > 0
        ? normalizeCategory(params.category)
        : "LOC";
    const product = await (0, lenderProducts_repo_1.createLenderProduct)({
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
async function listLenderProductsService(params) {
    const products = await (0, lenderProducts_repo_1.listLenderProducts)();
    const resolvedSilo = resolveSilo(params?.silo);
    return filterBySilo(products, resolvedSilo);
}
async function listLenderProductsByLenderIdService(params) {
    const products = await (0, lenderProducts_repo_1.listLenderProductsByLenderId)(params.lenderId);
    const resolvedSilo = resolveSilo(params.silo);
    return filterBySilo(products, resolvedSilo);
}
async function fetchLenderProductByIdService(params) {
    return (0, lenderProducts_repo_1.fetchLenderProductById)(params.id);
}
async function updateLenderProductService(params) {
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
    return (0, lenderProducts_repo_1.updateLenderProduct)(updatePayload);
}
