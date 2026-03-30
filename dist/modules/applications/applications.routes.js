"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
// Example handlers (keep your logic, just typed properly)
router.get('/', (req, res) => {
    res["json"]({ ok: true });
});
router.post('/', (req, res) => {
    res["json"]({ ok: true });
});
exports.default = router;
