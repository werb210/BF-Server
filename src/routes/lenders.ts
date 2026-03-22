import { Router } from "express";
import {
  getLenders,
  getLenderById,
  createLender,
  updateLender,
  getLenderWithProducts,
} from "../controllers/lenders.controller";
import { wrap } from "../utils/handlerWrapper";

const router = Router();

router.get("/", wrap(getLenders));
router.get("/:id", wrap(getLenderById));
router.post("/", wrap(createLender));
router.put("/:id", wrap(updateLender));
router.get("/:id/products", wrap(getLenderWithProducts));

export default router;
