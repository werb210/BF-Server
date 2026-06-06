// BF_SERVER_BLOCK_v750_TEAM_CHAT — REST for the internal staff "Team" chat.
import { Router } from "express";
import { ROLES } from "../auth/roles.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import {
  createGroup,
  createNamedChannel,
  findOrCreateDm,
  isMember,
  listChannelsForUser,
  listMessages,
  listStaffUsers,
  markRead,
  memberIdsOf,
  postMessage,
} from "../services/team/team.service.js";
import { broadcastToUsers } from "../ws/teamSocket.js";

const router = Router();
const requireStaff = requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] });

function userIdOf(req: { user?: { id?: string | null; userId?: string | null; sub?: string | null } | null }): string {
  const id = req.user?.id ?? req.user?.userId ?? req.user?.sub ?? null;
  if (!id) throw new AppError("unauthorized", "Authentication required.", 401);
  return String(id);
}

router.get(
  "/users",
  requireAuth,
  requireStaff,
  safeHandler(async (_req: any, res: any) => {
    res.status(200).json({ ok: true, users: await listStaffUsers() });
  }),
);

router.get(
  "/channels",
  requireAuth,
  requireStaff,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    res.status(200).json({ ok: true, channels: await listChannelsForUser(userId) });
  }),
);

router.post(
  "/channels",
  requireAuth,
  requireStaff,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const kind = String(req.body?.kind ?? "channel");
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const memberIds: string[] = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(String) : [];

    let channelId: string;
    if (kind === "dm") {
      const other = memberIds.find((id) => id && id !== userId);
      if (!other) throw new AppError("validation_error", "A direct message needs one other person.", 400);
      channelId = await findOrCreateDm(userId, other);
    } else if (kind === "group") {
      if (memberIds.filter((id) => id && id !== userId).length < 1) {
        throw new AppError("validation_error", "A group needs at least one other person.", 400);
      }
      channelId = await createGroup(name || null, userId, memberIds);
    } else {
      if (!name) throw new AppError("validation_error", "Channel name required.", 400);
      channelId = await createNamedChannel(name, userId, memberIds);
    }

    const members = await memberIdsOf(channelId);
    broadcastToUsers(members, { type: "channel", channel_id: channelId });
    res.status(200).json({ ok: true, channel_id: channelId });
  }),
);

router.get(
  "/channels/:id/messages",
  requireAuth,
  requireStaff,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const id = String(req.params.id);
    if (!(await isMember(id, userId))) throw new AppError("forbidden", "Not a member of this channel.", 403);
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    const limit = Number(req.query.limit ?? 50);
    res.status(200).json({
      ok: true,
      messages: await listMessages(id, { before, limit: Number.isFinite(limit) ? limit : 50 }),
    });
  }),
);

router.post(
  "/channels/:id/messages",
  requireAuth,
  requireStaff,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const id = String(req.params.id);
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) throw new AppError("validation_error", "Message body required.", 400);
    if (!(await isMember(id, userId))) throw new AppError("forbidden", "Not a member of this channel.", 403);
    const message = await postMessage(id, userId, body);
    const members = await memberIdsOf(id);
    broadcastToUsers(members, { type: "message", channel_id: id, message });
    res.status(200).json({ ok: true, message });
  }),
);

router.post(
  "/channels/:id/read",
  requireAuth,
  requireStaff,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const id = String(req.params.id);
    if (!(await isMember(id, userId))) throw new AppError("forbidden", "Not a member of this channel.", 403);
    await markRead(id, userId);
    res.status(200).json({ ok: true });
  }),
);

export default router;
