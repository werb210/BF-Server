import express, { Router } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation";

const router = Router();

router.post("/voice/status", express.urlencoded({ extended: false }), twilioWebhookValidation, async (req, res) => {
  try {
    const {
      CallSid,
      CallStatus,
      From,
      To,
      Duration,
    } = req.body;

    console.log("Call event", {
      CallSid,
      CallStatus,
      From,
      To,
      Duration,
    });

    res.status(200).send("ok");
  } catch {
    res.status(500).send("error");
  }
});

export default router;
