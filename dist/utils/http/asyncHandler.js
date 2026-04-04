"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asyncHandler = void 0;
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).then(() => undefined).catch(next);
exports.asyncHandler = asyncHandler;
