"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.internalOnly = internalOnly;
const config_1 = require("../config");
function internalOnly(req, res, next) {
    if (config_1.config.env === "test") {
        next();
        return;
    }
    const key = req.headers["x-internal-key"];
    const provided = Array.isArray(key) ? key[0] : key;
    const expected = config_1.config.internal.apiKey;
    if (provided !== expected) {
        res.status(403).json({ error: "Forbidden" });
        return;
    }
    next();
}
