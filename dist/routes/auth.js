"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const router = express_1.default.Router();
router.post("/otp/start", async (_req, res) => {
    res.sendStatus(204);
});
router.post("/otp/verify", async (_req, res) => {
    res.json({
        accessToken: "dev-access",
        refreshToken: "dev-refresh",
    });
});
router.get("/me", async (_req, res) => {
    res.json({ id: "dev-user", role: "Staff" });
});
router.post("/logout", async (_req, res) => {
    res.sendStatus(204);
});
exports.default = router;
