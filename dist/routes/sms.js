"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const router = express_1.default.Router();
router.post("/incoming", (req, res) => {
    console.log("Inbound SMS:", req.body);
    return res.type("text/xml").send("<Response></Response>");
});
exports.default = router;
