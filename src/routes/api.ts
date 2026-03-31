import { Router } from "express";

import applicationRoutes from "./applications.routes";
import documentRoutes from "./documents";
import userRoutes from "./users";

const router = Router();

router.use("/applications", applicationRoutes);
router.use("/documents", documentRoutes);
router.use("/users", userRoutes);

router.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

export default router;
