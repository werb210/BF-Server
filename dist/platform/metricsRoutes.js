"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const respond_1 = require("../lib/respond");
const metrics_1 = require("./metrics");
const router = express_1.default.Router();
router.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metrics_1.registry.contentType);
    return (0, respond_1.ok)(res, await metrics_1.registry.metrics());
});
exports.default = router;
