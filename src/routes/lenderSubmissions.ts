import { Router } from "express";
import lenderSubmissionsRoutes from "../modules/lenderSubmissions/lenderSubmissions.routes.js";

const router = Router();

router.use("/", lenderSubmissionsRoutes);

export default router;
