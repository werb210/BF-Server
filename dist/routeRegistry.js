"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const lender_routes_1 = __importDefault(require("./modules/lender/lender.routes"));
function registerRoutes(app) {
    app.use("/api/lender", lender_routes_1.default);
}
