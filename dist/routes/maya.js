"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const validate_1 = require("../middleware/validate");
const apiResponse_1 = require("../lib/apiResponse");
const schemas_1 = require("../schemas");
const routeWrap_1 = require("../lib/routeWrap");
const router = express_1.default.Router();
function requireMayaMessage(req, res, next) {
    if (!req.body?.message) {
        return next(new Error("INVALID_MESSAGE"));
    }
    return next();
}
async function handleMayaMessage(req, res) {
    const { message } = req.validated;
    return (0, apiResponse_1.ok)({
        reply: `Maya received: ${message}`,
    });
}
router.post("/chat", requireMayaMessage, (0, validate_1.validate)(schemas_1.MayaMessageSchema), (0, routeWrap_1.wrap)(handleMayaMessage));
router.post("/message", requireMayaMessage, (0, validate_1.validate)(schemas_1.MayaMessageSchema), (0, routeWrap_1.wrap)(handleMayaMessage));
exports.default = router;
