import { Router } from "express";

const router = Router();

/**
 * Temporary development token endpoint.
 * Allows the client telephony module to initialize
 * without requiring Twilio during local testing.
 */
router.get("/token", async (_req, res) => {
  res.json({
    token: "dev-token",
    identity: "dev-user",
  });
});

export default router;
