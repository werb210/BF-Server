import { Router } from "express";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import {
  fetchMe,
  updateMe,
  listUsers,
  adminUpdateUser,
  createUser,
  deleteUser,
} from "../services/users.service.js";
import adminUserRoutes from "../modules/users/users.routes.js";
import { ALL_ROLES, ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS

const router = Router();

async function handleMe(req: any, res: any) {
  try {
    const user = await fetchMe(req);
    if (!user) {
      res.status(500).json({ error: "me_unavailable" });
      return;
    }
    res.json(user);
  } catch {
    res.status(500).json({ error: "me_unavailable" });
  }
}

async function handlePatchMe(req: any, res: any) {
  try {
    const user = await fetchMe(req);
    if (!user) {
      res.status(500).json({ error: "me_unavailable" });
      return;
    }
  } catch {
    res.status(500).json({ error: "me_unavailable" });
    return;
  }

  return updateMe(req, res);
}


/**
 * Self profile
 */
router.get("/me", requireAuth, requireAuthorization({ roles: ALL_ROLES }), handleMe);
router.patch(
  "/me",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  safeHandler(handlePatchMe) // BF_SERVER_v789_SAFE_HANDLERS
);

/**
 * Admin user management
 */
router.get(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(listUsers) // BF_SERVER_v789_SAFE_HANDLERS
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
