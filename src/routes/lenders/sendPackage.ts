import { Router } from "express";
import { buildLenderPackage } from "../../services/lenders/packageBuilder";

const router = Router();

router.post("/send", async (req, res) => {
  try {
    const packageData = buildLenderPackage(req.body);

    return res.json({
      status: "sent",
      package: packageData,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: err?.message ?? "Failed to send package",
    });
  }
});

export default router;
