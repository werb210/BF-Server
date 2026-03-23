import { Router } from "express";
import rateLimit from "express-rate-limit";
import { submitContactForm } from "../modules/website/contact.controller";
import { submitCreditReadiness } from "../modules/website/website.controller";
import { config } from "@/config";

const router = Router();

const websiteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.env === "test",
});

const websiteBodyLimitBytes = 64 * 1024;

router.use(websiteLimiter);
router.use((req: any, res: any, next: any) => {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > websiteBodyLimitBytes) {
    res.status(413).json({ error: "Payload too large" });
    return;
  }
  next();
});

router.post("/credit-readiness", submitCreditReadiness);
router.post("/contact", submitContactForm);

export default router;
