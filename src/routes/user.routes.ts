import { Router } from "express";
import { body } from "express-validator";
import { createUser, deleteUser, getUser, updateUser } from "../controllers/user.controller";
import { auth } from "../middleware/auth";

const router = Router();

router.post(
  "/users",
  [body("email").isEmail(), body("password").isLength({ min: 8 })],
  createUser
);
router.get("/users/:id", auth, getUser);
router.patch(
  "/users/:id",
  [body("email").optional().isEmail(), body("password").optional().isLength({ min: 8 })],
  auth,
  updateUser
);
router.delete("/users/:id", auth, deleteUser);

export default router;
