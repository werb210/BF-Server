import { Router } from "express"
import {
  startVerification,
  checkVerification,
  isTwilioAvailable,
} from "../../services/twilio"

const router = Router()

router.post("/start", async (req, res, next) => {
  try {
    const { phone } = req.body

    if (!phone) {
      return res.status(400).json({
        code: "invalid_request",
        message: "phone is required",
      })
    }

    if (!isTwilioAvailable()) {
      return res.status(500).json({
        code: "config_error",
        message: "Missing required environment variable",
      })
    }

    await startVerification(phone)

    return res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

router.post("/verify", async (req, res, next) => {
  try {
    const { phone, code } = req.body

    if (!phone || !code) {
      return res.status(400).json({
        code: "invalid_request",
        message: "phone and code required",
      })
    }

    if (!isTwilioAvailable()) {
      return res.status(500).json({
        code: "config_error",
        message: "Missing required environment variable",
      })
    }

    const result = await checkVerification(phone, code)

    if (!result || result.status !== "approved") {
      return res.status(400).json({
        code: "invalid_code",
        message: "OTP not approved",
      })
    }

    return res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

export default router
