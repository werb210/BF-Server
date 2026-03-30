"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const continuation_service_1 = require("../../modules/continuation/continuation.service");
const router = (0, express_1.Router)();
/**
 * GET /api/client/continuation/:token
 */
router.get("/continuation/:token", async (req, res, next) => {
    const token = req.params.token;
    if (!token) {
        return res.status(401).json({ error: "Invalid token" });
    }
    try {
        const result = await (0, continuation_service_1.fetchContinuation)(token);
        if (!result) {
            return res.status(401).json({ error: "Invalid token" });
        }
        return res.status(200).json({ exists: true, application: result });
    }
    catch (err) {
        return res.status(500).json({ error: "Internal error" });
    }
});
exports.default = router;
