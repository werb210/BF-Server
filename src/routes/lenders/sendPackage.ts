import { Router } from "express";
import { buildLenderPackage } from "../../services/lenders/buildLenderPackage";

const router = Router();

router.post("/send", async (req, res) => {
  const { application, documents, creditSummary } = req.body;
  const lenderPackage = buildLenderPackage(application, documents, creditSummary);

  res.json({
    status: "sent",
    package: lenderPackage,
  });
});

export default router;
