import express from "express";
import { requireFields } from "../middleware/validate.js";
import { ok } from "../utils/response.js";
const router = express.Router();
router.post("/", requireFields(["name", "email", "message"]), (req, res) => {
    return res["json"](ok({ received: true }));
});
export default router;
