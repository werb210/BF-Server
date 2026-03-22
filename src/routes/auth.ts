import express from "express";

const router = express.Router();

router.post("/otp/start", async (_req, res) => {
  res.sendStatus(204);
});

router.post("/otp/verify", async (_req, res) => {
  res.json({
    accessToken: "dev-access",
    refreshToken: "dev-refresh",
  });
});

router.get("/me", async (_req, res) => {
  res.json({ id: "dev-user", role: "Staff" });
});

router.post("/logout", async (_req, res) => {
  res.sendStatus(204);
});

export default router;
