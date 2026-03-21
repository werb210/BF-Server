import { Router } from "express"
import {
  startVerification,
  checkVerification,
  isTwilioAvailable,
} from "../../services/twilio"

const router = Router()

router.post("/start", async (req, res, next) => {
  try {
    if (!isTwilioAvailable()) {
      throw new Error("Missing required environment variable")
    }

    const { phone } = req.body

    if (!phone) {
      return res.status(400).json({
        success: false,
        code: "invalid_request",
        message: "phone is required",
      })
    }

    await startVerification(phone)

    return res.json({
      success: true,
    })
  } catch (err) {
    next(err)
  }
})

router.post("/verify", async (req, res, next) => {
  try {
    if (!isTwilioAvailable()) {
      throw new Error("Missing required environment variable")
    }

    const { phone, code } = req.body

    if (!phone || !code) {
      return res.status(400).json({
        success: false,
        code: "invalid_request",
        message: "phone and code required",
      })
    }

    const result = await checkVerification(phone, code)

    if (result.status !== "approved") {
      return res.status(400).json({
        success: false,
        code: "invalid_code",
        message: "OTP not approved",
      })
    }

    return res.json({
      success: true,
    })
  } catch (err) {
    next(err)
  }
})

export default router
