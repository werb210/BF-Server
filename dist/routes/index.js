"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const lead_service_1 = require("../modules/lead/lead.service");
const calls_service_1 = require("../modules/calls/calls.service");
const service_1 = require("../modules/messaging/service");
const router = (0, express_1.Router)();
router.post("/lead", async (req, res) => {
    try {
        const result = await (0, lead_service_1.createLead)(req.body);
        res.json(result);
    }
    catch (err) {
        console.error("createLead failed:", err);
        res.status(500).json({ error: "create_lead_failed" });
    }
});
router.post("/call/start", async (req, res) => {
    try {
        const result = await (0, calls_service_1.startCall)(req.body);
        res.json(result);
    }
    catch (err) {
        console.error("startCall failed:", err);
        res.status(500).json({ error: "call_start_failed" });
    }
});
router.post("/call/status", async (req, res) => {
    try {
        const result = await (0, calls_service_1.updateCallStatus)(req.body);
        res.json(result);
    }
    catch (err) {
        console.error("updateCallStatus failed:", err);
        res.status(500).json({ error: "call_status_failed" });
    }
});
router.post("/message", async (req, res) => {
    try {
        const result = await (0, service_1.sendMessage)(req.body);
        res.json(result);
    }
    catch (err) {
        console.error("sendMessage failed:", err);
        res.status(500).json({ error: "message_failed" });
    }
});
exports.default = router;
