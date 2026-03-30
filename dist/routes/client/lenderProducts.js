"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const errors_1 = require("../../middleware/errors");
const safeHandler_1 = require("../../middleware/safeHandler");
const lenderProducts_repo_1 = require("../../repositories/lenderProducts.repo");
const lenderProductRequirementsService_1 = require("../../services/lenderProductRequirementsService");
const router = (0, express_1.Router)();
router.get("/lender-products", (0, safeHandler_1.safeHandler)(async (_req, res) => {
    const products = await (0, lenderProducts_repo_1.listLenderProducts)();
    res.status(200).json(products.map((p) => ({ id: p.id, name: p.name, type: p.category })));
}));
router.get("/lender-products/:id/requirements", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const lenderProductId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!lenderProductId) {
        throw new errors_1.AppError("validation_error", "Invalid request", 400);
    }
    const requirements = await (0, lenderProductRequirementsService_1.resolveLenderProductRequirements)({ lenderProductId });
    res.status(200).json(requirements);
}));
router.get("/lender-products/requirements", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    if (!category) {
        throw new errors_1.AppError("validation_error", "Invalid request", 400);
    }
    const country = typeof req.query.country === "string" ? req.query.country : undefined;
    const requestedAmountRaw = typeof req.query.requestedAmount === "string" && req.query.requestedAmount.trim().length > 0
        ? Number(req.query.requestedAmount)
        : null;
    const requestedAmount = typeof requestedAmountRaw === "number" && Number.isFinite(requestedAmountRaw)
        ? requestedAmountRaw
        : null;
    const requirements = await (0, lenderProductRequirementsService_1.listRequirementsForFilters)({
        category,
        country,
        requestedAmount,
    });
    res.status(200).json(requirements);
}));
exports.default = router;
