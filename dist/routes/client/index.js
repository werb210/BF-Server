"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const continuation_1 = __importDefault(require("./continuation"));
const documents_1 = __importDefault(require("./documents"));
const applications_1 = __importDefault(require("./applications"));
const lenders_1 = __importDefault(require("./lenders"));
const lenderProducts_1 = __importDefault(require("./lenderProducts"));
const clientSubmission_routes_1 = __importDefault(require("../../modules/clientSubmission/clientSubmission.routes"));
const session_1 = __importDefault(require("./session"));
const rateLimit_1 = require("../../middleware/rateLimit");
const router = (0, express_1.Router)();
const clientReadLimiter = (0, rateLimit_1.clientReadRateLimit)();
router.use((req, res, next) => {
    if (req.method === "GET") {
        clientReadLimiter(req, res, next);
        return;
    }
    next();
});
router.use("/", continuation_1.default);
router.use("/", applications_1.default);
router.use("/lenders", lenders_1.default);
router.use("/", lenderProducts_1.default);
router.use("/", clientSubmission_routes_1.default);
router.use("/", session_1.default);
router.use("/documents", (0, rateLimit_1.clientDocumentsRateLimit)(), documents_1.default);
exports.default = router;
