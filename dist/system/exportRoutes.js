"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listRoutes = listRoutes;
const printRoutes_1 = require("../debug/printRoutes");
function listRoutes(app) {
    return Array.from(new Set((0, printRoutes_1.listRoutes)(app).map((route) => route.path))).sort((a, b) => a.localeCompare(b));
}
