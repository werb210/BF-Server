"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fail = exports.ok = void 0;
const ok = (data) => ({
    success: true,
    data,
});
exports.ok = ok;
const fail = (error) => ({
    success: false,
    error,
});
exports.fail = fail;
