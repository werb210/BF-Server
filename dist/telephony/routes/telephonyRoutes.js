"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const router = express_1.default.Router();
// REQUIRED BY PORTAL
router.get("/token", async (_req, res) => {
    res["json"]({ token: "dev-token" });
});
router.get("/presence", async (_req, res) => {
    res["json"]({ status: "available" });
});
router.get("/call-status", async (_req, res) => {
    res["json"]({ calls: [] });
});
router.post("/outbound-call", async (_req, res) => {
    res["json"]({ success: true });
});
router.post("/call-status", async (_req, res) => {
    res["json"]({ updated: true });
});
exports.default = router;
