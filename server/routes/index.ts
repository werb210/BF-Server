import { Router } from "express";
import telephony from "./telephony";

const router = Router();

router.use("/telephony", telephony);

export default router;
