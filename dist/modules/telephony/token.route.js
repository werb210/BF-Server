"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get('/token', (_req, res) => {
    return res.status(200).json({
        ok: true,
        token: 'fake-telephony-token'
    });
});
exports.default = router;
