import { Router } from "express";
import { fetchContinuation, updateContinuationStep } from "../models/continuation";

const router = Router();

router.get("/:token", async (req: any, res: any, next: any) => {
  const token = req.params.token;
  const stepParam = typeof req.query.step === "string" ? Number(req.query.step) : null;
  const currentStep =
    typeof stepParam === "number" && Number.isInteger(stepParam) && stepParam > 0
      ? stepParam
      : 2;
  const applicationId = await fetchContinuation(token);

  if (!applicationId) {
    res.status(404).json({ error: "Invalid token" });
    return;
  }

  await updateContinuationStep(token, currentStep);
  res.json({ applicationId });
});

export default router;
