"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const endpoints_1 = require("../contracts/endpoints");
const response_1 = require("../lib/response");
const router = (0, express_1.Router)();
const API_PREFIX = "/api/v1";
function routeFromContract(endpoint) {
    return endpoint.startsWith(API_PREFIX) ? endpoint.slice(API_PREFIX.length) : endpoint;
}
function createLeadHandler(_req, res) {
    return (0, response_1.ok)(res, { saved: true });
}
function startCallHandler(_req, res) {
    return (0, response_1.ok)(res, { started: true });
}
function updateCallStatusHandler(_req, res) {
    return (0, response_1.ok)(res, { recorded: true });
}
function sendMessageHandler(_req, res) {
    return (0, response_1.ok)(res, { reply: "ok" });
}
router.post(routeFromContract(endpoints_1.endpoints.createLead), auth_1.requireAuth, createLeadHandler);
router.post(routeFromContract(endpoints_1.endpoints.startCall), auth_1.requireAuth, startCallHandler);
router.post(routeFromContract(endpoints_1.endpoints.updateCallStatus), auth_1.requireAuth, updateCallStatusHandler);
router.post(routeFromContract(endpoints_1.endpoints.sendMessage), auth_1.requireAuth, sendMessageHandler);
exports.default = router;
