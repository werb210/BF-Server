"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.endpoints = exports.API_BASE = void 0;
exports.API_BASE = "/api/v1";
exports.endpoints = Object.freeze({
    createLead: `${exports.API_BASE}/leads`,
    startCall: `${exports.API_BASE}/calls/start`,
    updateCallStatus: `${exports.API_BASE}/calls/status`,
    sendMessage: `${exports.API_BASE}/maya/message`,
});
