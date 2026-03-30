"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get('/', (req, res) => {
    res["json"]({ ok: true });
});
router.post('/', (req, res, next) => {
    res["json"]({ ok: true });
});
exports.default = router;
