"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.post('/ai', async (req, res, next) => {
    try {
        // placeholder logic
        return res["json"]({ success: true });
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
