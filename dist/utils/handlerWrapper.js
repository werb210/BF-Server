"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrap = void 0;
const wrap = (fn) => {
    return (...args) => fn(...args);
};
exports.wrap = wrap;
