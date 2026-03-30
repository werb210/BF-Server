"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const continuation_1 = require("../models/continuation");
const router = (0, express_1.Router)();
router.get("/:token", async (req, res, next) => {
    const token = req.params.token;
    const stepParam = typeof req.query.step === "string" ? Number(req.query.step) : null;
    const currentStep = typeof stepParam === "number" && Number.isInteger(stepParam) && stepParam > 0
        ? stepParam
        : 2;
    const applicationId = await (0, continuation_1.fetchContinuation)(token);
    if (!applicationId) {
        res.status(404).json({ error: "Invalid token" });
        return;
    }
    await (0, continuation_1.updateContinuationStep)(token, currentStep);
    res["json"]({ applicationId });
});
exports.default = router;
