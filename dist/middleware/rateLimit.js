"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clientDocumentsRateLimit = exports.clientReadRateLimit = exports.portalRateLimit = exports.voiceRateLimit = exports.lenderSubmissionRateLimit = exports.clientSubmissionRateLimit = exports.documentUploadRateLimit = exports.globalRateLimit = exports.apiRateLimit = void 0;
exports.pushSendRateLimit = pushSendRateLimit;
exports.adminRateLimit = adminRateLimit;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
exports.apiRateLimit = (0, express_rate_limit_1.default)({
    windowMs: 60000,
    max: 100,
});
exports.globalRateLimit = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 100,
});
exports.documentUploadRateLimit = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 50,
});
exports.clientSubmissionRateLimit = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 25,
});
exports.lenderSubmissionRateLimit = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 25,
});
function pushSendRateLimit() {
    return (_req, _res, next) => next();
}
function adminRateLimit() {
    return (_req, _res, next) => next();
}
// compatibility wrappers
const voiceRateLimit = () => exports.globalRateLimit;
exports.voiceRateLimit = voiceRateLimit;
const portalRateLimit = () => exports.globalRateLimit;
exports.portalRateLimit = portalRateLimit;
const clientReadRateLimit = () => exports.globalRateLimit;
exports.clientReadRateLimit = clientReadRateLimit;
const clientDocumentsRateLimit = () => exports.globalRateLimit;
exports.clientDocumentsRateLimit = clientDocumentsRateLimit;
