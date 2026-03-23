import { Router, type Request } from "express";
import { AppError } from "../../middleware/errors";
import { createUserAccount } from "../auth/auth.service";
import { changeUserRole, setUserStatus } from "./users.service";
import { normalizeRole } from "../../auth/roles";

const router = Router();

function buildRequestMetadata(req: Request): { ip?: string; userAgent?: string } {
  const metadata: { ip?: string; userAgent?: string } = {};
  if (req.ip) {
    metadata.ip = req.ip;
  }
  const userAgent = req.get("user-agent");
  if (userAgent) {
    metadata.userAgent = userAgent;
  }
  return metadata;
}

router.post("/", async (req: any, res: any, next: any) => {
  try {
    const { email, phoneNumber, role, lenderId } = req.body;
    const normalizedRole = typeof role === "string" ? normalizeRole(role) : null;
    const normalizedEmail =
      typeof email === "string" && email.trim().length > 0
        ? email.trim()
        : null;
    if (!normalizedEmail || role === undefined || role === null) {
      throw new AppError(
        "missing_fields",
        "email and role are required.",
        400
      );
    }
    if (!normalizedRole) {
      throw new AppError("invalid_role", "Role is invalid.", 400);
    }
    const user = await createUserAccount({
      email: normalizedEmail,
      phoneNumber,
      role: normalizedRole,
      lenderId,
      actorUserId: req.user?.userId ?? null,
      ...buildRequestMetadata(req),
    });
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/role", async (req: any, res: any, next: any) => {
  try {
    const actorId = req.user?.userId;
    if (!actorId) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const { role } = req.body ?? {};
    const normalizedRole = typeof role === "string" ? normalizeRole(role) : null;
    if (!normalizedRole) {
      throw new AppError("invalid_role", "Role is invalid.", 400);
    }
    await changeUserRole({
      userId: req.params.id,
      role: normalizedRole,
      actorId,
      ...buildRequestMetadata(req),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/disable", async (req: any, res: any, next: any) => {
  try {
    const actorId = req.user?.userId;
    if (!actorId) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const targetId = req.params.id;
    if (!targetId) {
      throw new AppError("validation_error", "id is required.", 400);
    }
    await setUserStatus({
      userId: targetId,
      active: false,
      actorId,
      ...buildRequestMetadata(req),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/enable", async (req: any, res: any, next: any) => {
  try {
    const actorId = req.user?.userId;
    if (!actorId) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const targetId = req.params.id;
    if (!targetId) {
      throw new AppError("validation_error", "id is required.", 400);
    }
    await setUserStatus({
      userId: targetId,
      active: true,
      actorId,
      ...buildRequestMetadata(req),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
