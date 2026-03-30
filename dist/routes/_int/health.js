"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.intHealthHandler = intHealthHandler;
const express_1 = require("express");
const router = (0, express_1.Router)();
function intHealthHandler(_req, res) {
    return res["json"]({
        success: true,
        status: 'ok',
    });
}
router.get('/', intHealthHandler);
exports.default = router;
