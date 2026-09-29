// BF_SERVER_TEAM_PHASE_B_v659 - REST for Team chat Phase B, mounted beside team.ts at /api/team:
// browse / join / leave / edit / archive channels, add people, threads, search everywhere.
import { Router } from "express";
import { ROLES } from "../auth/roles.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { isMember, memberIdsOf } from "../services/team/team.service.js";
import {
  addChannelMembers, browseChannels, channelMeta, joinChannel, leaveChannel, loadThread, nameTaken,
  normalizeChannelName, postThreadReply, pushThreadReply, searchEverything, setArchived, updateChannel,
} from "../services/team/teamChannels.js";
import { broadcastToUsers } from "../ws/teamSocket.js";
import { askMaya } from "../services/team/teamPhaseC.js"; // BF_SERVER_TEAM_PHASE_C_v671

const router = Router();
const requireStaff = requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] });
const guard = [requireAuth, requireStaff];

function userIdOf(req: any): string {
  const id = req.user?.id ?? req.user?.userId ?? req.user?.sub ?? null;
  if (!id) throw new AppError("unauthorized", "Authentication required.", 401);
  return String(id);
}
async function mustBeMember(channelId: string, userId: string): Promise<void> {
  if (!(await isMember(channelId, userId))) throw new AppError("forbidden", "Not a member of this channel.", 403);
}
async function announce(channelId: string, extra: string[] = []): Promise<void> {
  broadcastToUsers(Array.from(new Set([...(await memberIdsOf(channelId)), ...extra])), { type: "channel", channel_id: channelId });
}

router.get("/channels/browse", ...guard, safeHandler(async (req: any, res: any) => {
  res.status(200).json({ ok: true, channels: await browseChannels(userIdOf(req)) });
}));

router.post("/channels/:id/join", ...guard, safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req); const id = String(req.params.id);
  const result = await joinChannel(id, userId);
  if (result === "not_found") throw new AppError("not_found", "Channel not found.", 404);
  if (result === "private") throw new AppError("forbidden", "This channel is private. Ask a member to add you.", 403);
  if (result === "archived") throw new AppError("conflict", "This channel is archived.", 409);
  await announce(id);
  res.status(200).json({ ok: true });
}));

router.post("/channels/:id/leave", ...guard, safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req); const id = String(req.params.id);
  const result = await leaveChannel(id, userId);
  if (result === "dm") throw new AppError("validation_error", "You can't leave a direct message.", 400);
  await announce(id, [userId]);
  res.status(200).json({ ok: true, left: result === "left" });
}));

router.patch("/channels/:id", ...guard, safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req); const id = String(req.params.id);
  await mustBeMember(id, userId);
  const meta = await channelMeta(id);
  if (!meta || meta.kind === "dm") throw new AppError("validation_error", "Direct messages have no name or topic.", 400);
  const patch: { name?: string; topic?: string | null; is_private?: boolean } = {};
  if (req.body?.name !== undefined) {
    const name = meta.kind === "channel" ? normalizeChannelName(req.body.name) : String(req.body.name ?? "").trim().slice(0, 80);
    if (!name) throw new AppError("validation_error", "Channel name required.", 400);
    if (meta.kind === "channel" && (await nameTaken(name, id))) throw new AppError("conflict", "A channel called #" + name + " already exists.", 409);
    patch.name = name;
  }
  if (req.body?.topic !== undefined) patch.topic = req.body.topic == null ? null : String(req.body.topic);
  if (req.body?.is_private !== undefined && meta.kind === "channel") patch.is_private = Boolean(req.body.is_private);
  const channel = await updateChannel(id, patch);
  await announce(id);
  res.status(200).json({ ok: true, channel });
}));

router.post("/channels/:id/archive", ...guard, safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req); const id = String(req.params.id);
  await mustBeMember(id, userId);
  const meta = await channelMeta(id);
  if (!meta || meta.kind !== "channel") throw new AppError("validation_error", "Only named channels can be archived.", 400);
  const channel = await setArchived(id, req.body?.archived !== false);
  await announce(id);
  res.status(200).json({ ok: true, channel });
}));

router.post("/channels/:id/members", ...guard, safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req); const id = String(req.params.id);
  await mustBeMember(id, userId);
  const meta = await channelMeta(id);
  if (!meta || meta.kind === "dm") throw new AppError("validation_error", "Start a group to add people to a direct message.", 400);
  const ids: string[] = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(String).slice(0, 100) : [];
  if (!ids.length) throw new AppError("validation_error", "member_ids required.", 400);
  await addChannelMembers(id, ids);
  await announce(id, ids);
  res.status(200).json({ ok: true });
}));

router.get("/channels/:id/threads/:rootId", ...guard, safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req); const id = String(req.params.id);
  await mustBeMember(id, userId);
  const thread = await loadThread(id, String(req.params.rootId));
  if (!thread) throw new AppError("not_found", "Thread not found.", 404);
  res.status(200).json({ ok: true, ...thread });
}));

router.post("/channels/:id/threads/:rootId/messages", ...guard, safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req); const id = String(req.params.id); const rootId = String(req.params.rootId);
  await mustBeMember(id, userId);
  if ((await channelMeta(id))?.archived_at) throw new AppError("conflict", "This channel is archived.", 409);
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
    .filter((a: any) => a && typeof a.dataUrl === "string" && a.dataUrl.length < 7_000_000).slice(0, 10)
    .map((a: any) => ({ name: typeof a.name === "string" ? a.name.slice(0, 200) : "file", contentType: typeof a.contentType === "string" ? a.contentType.slice(0, 100) : "application/octet-stream", dataUrl: String(a.dataUrl) }));
  const mentions: string[] = Array.isArray(req.body?.mentions) ? req.body.mentions.map(String).slice(0, 50) : [];
  if (!body && !attachments.length) throw new AppError("validation_error", "Message body or attachment required.", 400);
  const posted = await postThreadReply(id, rootId, userId, body, attachments.length ? attachments : null, mentions.length ? mentions : null);
  if (!posted) throw new AppError("not_found", "Thread not found.", 404);
  broadcastToUsers(await memberIdsOf(id), { type: "thread_message", channel_id: id, root_id: rootId, message: posted.message, summary: posted.summary });
  void pushThreadReply(id, rootId, { sender_id: userId, body, mentions });
  void askMaya(id, posted.message as any, userId); // BF_SERVER_TEAM_PHASE_C_v671
  res.status(200).json({ ok: true, message: posted.message, summary: posted.summary });
}));

router.get("/search", ...guard, safeHandler(async (req: any, res: any) => {
  const q = typeof req.query?.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  if (q.length < 2) { res.status(200).json({ ok: true, messages: [], channels: [] }); return; }
  res.status(200).json({ ok: true, ...(await searchEverything(userIdOf(req), q)) });
}));

export default router;
