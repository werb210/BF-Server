"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_js_1 = require("../middleware/auth.js");
const response_1 = require("../lib/response");
const toStringSafe_1 = require("../utils/toStringSafe");
const router = express_1.default.Router();
const db = {};
router.post("/upload", auth_js_1.requireAuth, (req, res) => {
    const id = Date.now().toString();
    const doc = {
        id,
        status: "uploaded",
        metadata: req.body
    };
    db[id] = doc;
    return (0, response_1.ok)(res, doc);
});
router.patch("/:id/accept", auth_js_1.requireAuth, (req, res) => {
    const doc = db[(0, toStringSafe_1.toStringSafe)(req.params.id)];
    if (!doc)
        return (0, response_1.fail)(res, "Not found", 404);
    doc.status = "accepted";
    return (0, response_1.ok)(res, doc);
});
router.patch("/:id/reject", auth_js_1.requireAuth, (req, res) => {
    const doc = db[(0, toStringSafe_1.toStringSafe)(req.params.id)];
    if (!doc)
        return (0, response_1.fail)(res, "Not found", 404);
    doc.status = "rejected";
    return (0, response_1.ok)(res, doc);
});
exports.default = router;
