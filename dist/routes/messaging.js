"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const twilioClient_1 = require("../lib/twilioClient");
const routeWrap_1 = require("../lib/routeWrap");
const router = (0, express_1.Router)();
router.post("/sms", (0, routeWrap_1.wrap)(async (req) => {
    const { to, body } = req.body;
    if (!to || !body) {
        throw Object.assign(new Error("INVALID_SMS_PAYLOAD"), { status: 400 });
    }
    if (!twilioClient_1.twilioEnabled || !twilioClient_1.twilioClient) {
        throw Object.assign(new Error("twilio_not_configured"), { status: 503 });
    }
    const msg = await twilioClient_1.twilioClient.messages.create({
        to,
        from: twilioClient_1.fromNumber,
        body,
    });
    return { sid: msg.sid };
}));
router.post("/call", (0, routeWrap_1.wrap)(async (req) => {
    const { to, twimlUrl } = req.body;
    if (!to || !twimlUrl) {
        throw Object.assign(new Error("INVALID_CALL_PAYLOAD"), { status: 400 });
    }
    if (!twilioClient_1.twilioEnabled || !twilioClient_1.twilioClient) {
        throw Object.assign(new Error("twilio_not_configured"), { status: 503 });
    }
    const call = await twilioClient_1.twilioClient.calls.create({
        to,
        from: twilioClient_1.callerId,
        url: twimlUrl,
    });
    return { sid: call.sid };
}));
exports.default = router;
