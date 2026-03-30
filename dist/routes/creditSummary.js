"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const errors_1 = require("../middleware/errors");
const safeHandler_1 = require("../middleware/safeHandler");
const router = (0, express_1.Router)();
router.post("/", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "applicationId is required.", 400);
    }
    const payload = req.body ?? {};
    const sections = {
        Transaction: payload.Transaction ?? "Transaction details compiled from submitted package.",
        Overview: payload.Overview ?? "Business overview generated for underwriting review.",
        Collateral: payload.Collateral ?? "Collateral position summarized from provided documents.",
        "Financial Summary": payload["Financial Summary"] ?? "Financial summary generated from statements and application data.",
        "Risks & Mitigants": payload["Risks & Mitigants"] ?? "Risk signals reviewed with mitigating factors documented.",
        "Rationale for Approval": payload["Rationale for Approval"] ?? "Recommendation rationale prepared for lender review.",
    };
    res.status(200).json({
        applicationId,
        sections,
    });
}));
exports.default = router;
