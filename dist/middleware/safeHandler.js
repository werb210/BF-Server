"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeHandler = safeHandler;
function safeHandler(fn) {
    return function (req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
