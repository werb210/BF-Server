"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readyHandler = readyHandler;
function readyHandler(req, res) {
    const deps = req.app.locals.deps;
    if (!deps || !deps.db) {
        return res.status(503).json({ status: "not_ready" });
    }
    if (deps.db.ready !== true) {
        return res.status(503).json({ status: "not_ready" });
    }
    return res.status(200).json({ status: "ok" });
}
