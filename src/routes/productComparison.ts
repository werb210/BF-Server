import { Router } from "express";

const router = Router();

router.get("/", (_req: any, res: any) => {
  res.json({
    bank: {
      speed: "2-8 weeks",
      flexibility: "Low",
      approvalRate: "40-50%",
    },
    marketplace: {
      speed: "24-72 hours",
      flexibility: "High",
      approvalRate: "70-85%",
    },
  });
});

export default router;
