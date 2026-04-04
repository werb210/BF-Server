"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeWrap = exports.wrap = void 0;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
exports.wrap = wrap;
exports.routeWrap = exports.wrap;
