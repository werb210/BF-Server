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
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
  reactionsForOne,
  getMessageMeta,
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
    // BF_SERVER_TEAM_ATTACH_v1 — accept up to 10 attachments (data URLs, ~5MB each).
    const rawAtts: any[] = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const attachments = rawAtts
      .filter((a) => a && typeof a.dataUrl === "string" && a.dataUrl.length < 7_000_000)
      .slice(0, 10)
      .map((a) => ({
        name: typeof a.name === "string" ? a.name.slice(0, 200) : "file",
        contentType: typeof a.contentType === "string" ? a.contentType.slice(0, 100) : "application/octet-stream",
        dataUrl: String(a.dataUrl),
      }));
    const replyToId = typeof req.body?.reply_to_id === "string" ? req.body.reply_to_id : null;
    if (!body && attachments.length === 0) throw new AppError("validation_error", "Message body or attachment required.", 400);
    if (!(await isMember(id, userId))) throw new AppError("forbidden", "Not a member of this channel.", 403);
    const message = await postMessage(id, userId, body, attachments.length ? attachments : null, replyToId);
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

// BF_SERVER_TEAM_LIFECYCLE_v1 — edit / delete own message + reactions.
router.patch(
  "/channels/:id/messages/:mid",
  requireAuth,
  requireStaff,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const id = String(req.params.id);
    const mid = String(req.params.mid);
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) throw new AppError("validation_error", "Message body required.", 400);
    if (!(await isMember(id, userId))) throw new AppError("forbidden", "Not a member of this channel.", 403);
    const meta = await getMessageMeta(mid);
    if (!meta || meta.channel_id !== id) throw new AppError("not_found", "Message not found.", 404);
    const message = await editMessage(mid, userId, body);
    if (!message) throw new AppError("forbidden", "You can only edit your own message.", 403);
    broadcastToUsers(await memberIdsOf(id), { type: "message_update", channel_id: id, message });
    res.status(200).json({ ok: true, message });
  }),
);

router.delete(
  "/channels/:id/messages/:mid",
  requireAuth,
  requireStaff,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const id = String(req.params.id);
    const mid = String(req.params.mid);
    if (!(await isMember(id, userId))) throw new AppError("forbidden", "Not a member of this channel.", 403);
    const meta = await getMessageMeta(mid);
    if (!meta || meta.channel_id !== id) throw new AppError("not_found", "Message not found.", 404);
    const message = await deleteMessage(mid, userId);
    if (!message) throw new AppError("forbidden", "You can only delete your own message.", 403);
    broadcastToUsers(await memberIdsOf(id), { type: "message_update", channel_id: id, message });
    res.status(200).json({ ok: true, message });
  }),
);

router.post(
  "/channels/:id/messages/:mid/reactions",
  requireAuth,
  requireStaff,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const id = String(req.params.id);
    const mid = String(req.params.mid);
    const emoji = typeof req.body?.emoji === "string" ? req.body.emoji.slice(0, 16) : "";
    if (!emoji) throw new AppError("validation_error", "Emoji required.", 400);
    if (!(await isMember(id, userId))) throw new AppError("forbidden", "Not a member of this channel.", 403);
    const meta = await getMessageMeta(mid);
    if (!meta || meta.channel_id !== id) throw new AppError("not_found", "Message not found.", 404);
    await addReaction(mid, userId, emoji);
    const reactions = await reactionsForOne(mid);
    broadcastToUsers(await memberIdsOf(id), { type: "reaction", channel_id: id, message_id: mid, reactions });
    res.status(200).json({ ok: true, reactions });
  }),
);

router.delete(
  "/channels/:id/messages/:mid/reactions",
  requireAuth,
  requireStaff,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const id = String(req.params.id);
    const mid = String(req.params.mid);
    const emoji = typeof req.query?.emoji === "string"
      ? String(req.query.emoji).slice(0, 16)
      : (typeof req.body?.emoji === "string" ? req.body.emoji.slice(0, 16) : "");
    if (!emoji) throw new AppError("validation_error", "Emoji required.", 400);
    if (!(await isMember(id, userId))) throw new AppError("forbidden", "Not a member of this channel.", 403);
    const meta = await getMessageMeta(mid);
    if (!meta || meta.channel_id !== id) throw new AppError("not_found", "Message not found.", 404);
    await removeReaction(mid, userId, emoji);
    const reactions = await reactionsForOne(mid);
    broadcastToUsers(await memberIdsOf(id), { type: "reaction", channel_id: id, message_id: mid, reactions });
    res.status(200).json({ ok: true, reactions });
  }),
);

export default router;
