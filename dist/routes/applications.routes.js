"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
router.get("/", (req, res) => {
    res["json"]({ ok: true, data: [] });
});
router.post("/", (req, res) => {
    res.status(201).json({ ok: true, data: { id: "app-1", ...req.body } });
});
router.get("/:id", (req, res) => {
    res["json"]({ ok: true, data: { id: req.params.id } });
});
router.get("/:id/documents", (req, res) => {
    res["json"]({ ok: true, data: [] });
});
exports.default = router;
