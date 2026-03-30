"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get("/", (_req, res) => {
    res["json"]({
        bank: {
            speed: "2-8 weeks",
            flexibility: "Low",
            approvalRate: "40-50%",
        },
        marketplace: {
            speed: "24-72 hours",
            flexibility: "High",
            approvalRate: "70-85%",
        },
    });
});
exports.default = router;
