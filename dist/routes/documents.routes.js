"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.post("/upload", (req, res) => {
    res["json"]({
        ok: true,
        data: { id: "doc-1", status: "uploaded" },
    });
});
exports.default = router;
