import { AppError } from "../../middleware/errors";
import { recordAuditEvent } from "../audit/audit.service";
import {
  findAuthUserById,
  incrementTokenVersion,
  revokeRefreshTokensForUser,
  setUserActive,
  updateUserRoleById,
} from "../auth/auth.repo";
import { type Role } from "../../auth/roles";
import { pool } from "../../db";

export async function setUserStatus(params: {
  userId: string;
  active: boolean;
  actorId: string;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  const user = await findAuthUserById(params.userId);
  if (!user) {
    await recordAuditEvent({
      action: params.active ? "user_enabled" : "user_disabled",
      actorUserId: params.actorId,
      targetUserId: params.userId,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: false,
    });
    throw new AppError("not_found", "User not found.", 404);
  }
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    await setUserActive(params.userId, params.active, client);
    if (!params.active) {
      await incrementTokenVersion(params.userId, client);
      await revokeRefreshTokensForUser(params.userId, client);
      await recordAuditEvent({
        action: "token_revoke",
        actorUserId: params.actorId,
        targetUserId: params.userId,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        client,
      });
    }
    await recordAuditEvent({
      action: params.active ? "user_enabled" : "user_disabled",
      actorUserId: params.actorId,
      targetUserId: params.userId,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: true,
      client,
    });
    await client.runQuery("commit");
  } catch (err) {
    await client.runQuery("rollback");
    await recordAuditEvent({
      action: params.active ? "user_enabled" : "user_disabled",
      actorUserId: params.actorId,
      targetUserId: params.userId,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: false,
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function changeUserRole(params: {
  userId: string;
  role: Role;
  actorId: string;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  const user = await findAuthUserById(params.userId);
  if (!user) {
    await recordAuditEvent({
      action: "user_role_changed",
      actorUserId: params.actorId,
      targetUserId: params.userId,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: false,
    });
    throw new AppError("not_found", "User not found.", 404);
  }
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    await updateUserRoleById(params.userId, params.role, client);
    await incrementTokenVersion(params.userId, client);
    await revokeRefreshTokensForUser(params.userId, client);
    await recordAuditEvent({
      action: "token_revoke",
      actorUserId: params.actorId,
      targetUserId: params.userId,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: true,
      client,
    });
    await recordAuditEvent({
      action: "user_role_changed",
      actorUserId: params.actorId,
      targetUserId: params.userId,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: true,
      client,
    });
    await client.runQuery("commit");
  } catch (err) {
    await client.runQuery("rollback");
    await recordAuditEvent({
      action: "user_role_changed",
      actorUserId: params.actorId,
      targetUserId: params.userId,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: false,
    });
    throw err;
  } finally {
    client.release();
  }
}
