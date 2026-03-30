"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeApiPath = normalizeApiPath;
function normalizeApiPath(req, _res, next) {
    if (req.url.startsWith("/api/api/")) {
        req.url = req.url.replace("/api/api/", "/api/");
    }
    if (req.url.startsWith("/auth/") || req.url === "/auth") {
        req.url = `/api${req.url}`;
    }
    next();
}
