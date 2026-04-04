"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get("/test", (_req, res) => {
    return res.status(200).json({ success: true });
});
exports.default = router;
