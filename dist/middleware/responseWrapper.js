"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeResponseWrapper = safeResponseWrapper;
function safeResponseWrapper(_req, res, next) {
    // Do not override the global response serializer here.
    next();
}
