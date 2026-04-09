import { Router } from "express";

import applicationRoutes from "./applications.routes.js";
import documentRoutes from "./documents.js";
import userRoutes from "./users.js";

const router = Router();

router.use("/applications", applicationRoutes);
router.use("/documents", documentRoutes);
router.use("/users", userRoutes);

router.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", data: {} });
});

export default router;
