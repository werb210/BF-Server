"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readyHandler = void 0;
exports.readyRoute = readyRoute;
const deps_1 = require("../system/deps");
function readyRoute(_req, res) {
    if (!deps_1.deps.db.ready) {
        return res.status(503).json({ status: "not_ready" });
    }
    return res.status(200).json({ status: "ok" });
}
exports.readyHandler = readyRoute;
