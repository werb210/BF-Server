import { Router } from "express";

const router = Router();

router.post("/voice/status", async (req, res) => {
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
