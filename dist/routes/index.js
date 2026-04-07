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
function createLeadHandler(req, _res) {
    return (0, response_1.ok)({ saved: true }, req.rid);
}
function startCallHandler(req, _res) {
    return (0, response_1.ok)({ started: true }, req.rid);
}
function updateCallStatusHandler(req, _res) {
    return (0, response_1.ok)({ recorded: true }, req.rid);
}
function sendMessageHandler(req, _res) {
    return (0, response_1.ok)({ reply: "ok" }, req.rid);
}
router.post(routeFromContract(endpoints_1.endpoints.createLead), auth_1.requireAuth, createLeadHandler);
router.post(routeFromContract(endpoints_1.endpoints.startCall), auth_1.requireAuth, startCallHandler);
router.post(routeFromContract(endpoints_1.endpoints.updateCallStatus), auth_1.requireAuth, updateCallStatusHandler);
router.post(routeFromContract(endpoints_1.endpoints.sendMessage), auth_1.requireAuth, sendMessageHandler);
exports.default = router;
