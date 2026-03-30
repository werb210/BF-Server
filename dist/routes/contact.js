"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const validate_js_1 = require("../middleware/validate.js");
const response_js_1 = require("../utils/response.js");
const router = express_1.default.Router();
router.post("/", (0, validate_js_1.requireFields)(["name", "email", "message"]), (req, res) => {
    return res["json"]((0, response_js_1.ok)({ received: true }));
});
exports.default = router;
