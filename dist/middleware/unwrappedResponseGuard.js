"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unwrappedResponseGuard = unwrappedResponseGuard;
function unwrappedResponseGuard(_req, _res, next) {
    // Disabled — was causing unintended 500s
    next();
}
