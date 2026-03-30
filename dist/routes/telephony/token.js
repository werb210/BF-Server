"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const response_1 = require("../../lib/response");
const router = express_1.default.Router();
router.get("/token", (_req, res) => {
    const token = "real-token";
    return (0, response_1.ok)(res, { token });
});
exports.default = router;
