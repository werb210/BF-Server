import express, { Router } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
const router = Router();
router.post("/voice/status", express.urlencoded({ extended: false }), twilioWebhookValidation, async (req, res, next) => {
    try {
        const { CallSid, CallStatus, From, To, Duration, } = req.body;
        console.log("Call event", {
            CallSid,
            CallStatus,
            From,
            To,
            Duration,
        });
        return res.status(200).json("ok");
    }
    catch {
        return res.status(500).json("error");
    }
});
export default router;
