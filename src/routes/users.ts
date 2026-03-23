import { Router } from "express";
import { requireAuth, requireAuthorization } from "../middleware/auth";
import {
  fetchMe,
  updateMe,
  listUsers,
  adminUpdateUser,
  createUser,
  deleteUser,
} from "../services/users.service";
import adminUserRoutes from "../modules/users/users.routes";
import { ALL_ROLES, ROLES } from "../auth/roles";

const router = Router();

/**
 * Self profile
 */
router.get("/me", requireAuth, requireAuthorization({ roles: ALL_ROLES }), fetchMe);
router.patch(
  "/me",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  updateMe
);

/**
 * Admin user management
 */
router.get(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  listUsers
);
router.post(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  createUser
);
router.patch(
  "/:id",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  adminUpdateUser
);
router.delete(
  "/:id",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  deleteUser
);
router.use(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  adminUserRoutes
);

export default router;
