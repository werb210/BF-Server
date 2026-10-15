// BF_SERVER_v810_LIBRARY_PLUS - Dropbox-style Staff Library: search, preview, rename / move / delete with a 30-day
// recycle bin, stars, recent, activity, version history, share links for people outside Boreal, upload links (file
// requests), whole-folder zip downloads and the file content for "Send to client". Mounted under /api/o365/library
// (staff sign-in required by the o365 router). Files stay in OneDrive; see src/modules/library.
import { Router } from "express";
import archiver from "archiver";
import { Readable } from "node:stream";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { getGraphForUser, type GraphClient } from "../modules/o365/graphClient.js";
import * as repo from "../modules/library/library.repo.js";
import * as g from "../modules/library/libraryGraph.js";

const router = Router();

export const SEND_TO_CLIENT_MAX_BYTES = 3 * 1024 * 1024; // a chat attachment; bigger files go as a link
export const ZIP_MAX_FILES = 1000;
export const ZIP_MAX_BYTES = 500 * 1024 * 1024;
export const SHARE_MAX_DAYS = 90;

export function publicBase(): string {
  return String(process.env.PUBLIC_BASE_URL || "https://server.boreal.financial").replace(/\/+$/, "");
}
export function actorOf(req: any): { id: string; name: string | null } {
  const u = req.user ?? {};
  const full = [u.first_name ?? u.firstName, u.last_name ?? u.lastName].filter(Boolean).join(" ").trim();
  return { id: String(u.id ?? u.userId ?? ""), name: full || u.name || u.email || null };
}
export function clampDays(raw: unknown, dflt: number): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, SHARE_MAX_DAYS) : dflt;
}

type Ctx = { graph: GraphClient; lib: repo.LibraryRow & { drive_id: string }; actor: { id: string; name: string | null } };

const redeemed = new Set<string>();
// The caller's Graph client and the library. Redeeming the organization link once gives a staff member who is not
// the library's owner lasting access to it (same as v777).
async function ctx(req: any, res: any): Promise<Ctx | null> {
  const actor = actorOf(req);
  if (!actor.id) { res.status(401).json({ error: "unauthenticated" }); return null; }
  const lib = await repo.getLibrary();
  if (!lib || !lib.drive_id) { res.status(409).json({ error: "library_missing", message: "Create the Staff Library first." }); return null; }
  const graph = await getGraphForUser(pool, actor.id);
  if (!graph) { res.status(412).json({ error: "o365_not_connected" }); return null; }
  if (!redeemed.has(actor.id)) {
    const sid = "u!" + Buffer.from(lib.share_url).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
    const r = await graph.fetch("/shares/" + sid + "/driveItem?$select=id", { headers: { Prefer: "redeemSharingLink" } }).catch((err: unknown) => {
      console.warn("[staff-library] redeem failed", err instanceof Error ? err.message : String(err));
      return null;
    });
    if (r?.ok) redeemed.add(actor.id);
  }
  return { graph, lib: lib as Ctx["lib"], actor };
}

function sendError(res: any, err: unknown): void {
  if (err instanceof g.LibraryGraphError) { res.status(err.status).json({ error: err.code, message: err.message, detail: err.detail }); return; }
  throw err;
}

// The library's own path in OneDrive, so an item can be checked to be inside it.
const rootPathCache = new Map<string, string>();
async function libraryRootPath(c: Ctx): Promise<string> {
  const key = c.lib.drive_id + ":" + c.lib.item_id;
  const hit = rootPathCache.get(key);
  if (hit) return hit;
  const root = await g.getItem(c.graph, c.lib.drive_id, c.lib.item_id);
  const p = String(root?.parentReference?.path ?? "") + "/" + String(root?.name ?? "");
  rootPathCache.set(key, p);
  return p;
}
export function isUnder(itemParentPath: string | null | undefined, rootPath: string): boolean {
  const p = String(itemParentPath ?? "");
  return p === rootPath || p.startsWith(rootPath + "/");
}
// A library item (never the library folder itself), loaded with its details.
async function libraryItem(c: Ctx, id: string): Promise<any> {
  if (!g.isItemId(id) || id === c.lib.item_id) throw new g.LibraryGraphError(400, "bad_item", "Pick a file or folder in the library.");
  const item = await g.getItem(c.graph, c.lib.drive_id, id);
  if (!isUnder(item?.parentReference?.path, await libraryRootPath(c))) throw new g.LibraryGraphError(404, "not_in_library", "That isn't in the Staff Library.");
  return item;
}
async function trashFolderId(c: Ctx): Promise<string> {
  if (c.lib.trash_item_id) return c.lib.trash_item_id;
  const f = await g.ensureFolder(c.graph, c.lib.drive_id, c.lib.item_id, repo.TRASH_FOLDER_NAME);
  await repo.setTrashFolder(f.id);
  c.lib.trash_item_id = f.id;
  return f.id;
}
async function purgeExpired(c: Ctx): Promise<void> {
  for (const t of await repo.expiredTrash()) {
    try {
      await g.deleteItem(c.graph, c.lib.drive_id, t.item_id);
      await repo.removeTrash(t.item_id);
    } catch (err) {
      console.warn("[staff-library] purge failed", { itemId: t.item_id, message: err instanceof Error ? err.message : String(err) });
    }
  }
}
const inTrash = (c: Ctx, i: any) => !!c.lib.trash_item_id && (i.id === c.lib.trash_item_id || String(i?.parentReference?.path ?? "").includes("/" + repo.TRASH_FOLDER_NAME));

// ---- search ----------------------------------------------------------------------------------------------------
router.get("/search", safeHandler(async (req: any, res: any) => {
  const q = String(req.query?.q ?? "").trim();
  if (q.length < 2) return res.status(400).json({ error: "q_required", message: "Type at least 2 letters." });
  const c = await ctx(req, res); if (!c) return;
  try {
    const found = (await g.searchLibrary(c.graph, c.lib.drive_id, c.lib.item_id, q)).filter((i) => i.id !== c.lib.item_id && !inTrash(c, i));
    res.json({ items: found.map(g.mapLibraryItem) });
  } catch (err) { sendError(res, err); }
}));

// ---- preview / open / content ------------------------------------------------------------------------------------
router.get("/item/:id/preview", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  try {
    const item = await libraryItem(c, String(req.params.id));
    if (item.folder) return res.status(400).json({ error: "not_a_file", message: "That is a folder." });
    const mime = String(item.file?.mimeType ?? "");
    const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime === "application/pdf" ? "pdf" : "office";
    const embed = await g.previewUrl(c.graph, c.lib.drive_id, item.id);
    const dl = kind === "image" || !embed ? (await g.downloadUrl(c.graph, c.lib.drive_id, item.id)).url : null;
    await repo.logActivity({ itemId: item.id, itemName: item.name, action: "opened", actorId: c.actor.id, actorName: c.actor.name });
    res.json({ kind, embedUrl: embed, downloadUrl: dl, webUrl: item.webUrl ?? null, item: g.mapLibraryItem(item) });
  } catch (err) { sendError(res, err); }
}));

router.get("/item/:id/content", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  try {
    const item = await libraryItem(c, String(req.params.id));
    const d = await g.downloadUrl(c.graph, c.lib.drive_id, item.id);
    if (d.size > SEND_TO_CLIENT_MAX_BYTES) return res.status(413).json({ error: "too_large", message: "Over 3 MB: send it as a link instead.", size: d.size });
    const got = await fetch(d.url);
    if (!got.ok) return res.status(502).json({ error: "download_failed", message: "OneDrive did not send the file." });
    const buf = Buffer.from(await got.arrayBuffer());
    res.json({ name: d.name, contentType: d.mimeType, size: buf.length, dataUrl: "data:" + d.mimeType + ";base64," + buf.toString("base64") });
  } catch (err) { sendError(res, err); }
}));

router.get("/clients", safeHandler(async (req: any, res: any) => {
  const q = String(req.query?.q ?? "").trim();
  if (q.length < 2) return res.json({ items: [] });
  res.json({ items: await repo.searchClients(q) });
}));

router.post("/item/:id/sent", safeHandler(async (req: any, res: any) => {
  const actor = actorOf(req);
  const name = String(req.body?.name ?? "").slice(0, 300);
  const how = ["portal", "email", "text"].includes(String(req.body?.how)) ? String(req.body.how) : "portal";
  const to = String(req.body?.to ?? "").slice(0, 200);
  if (!g.isItemId(req.params.id) || !name) return res.status(400).json({ error: "bad_request" });
  await repo.logActivity({ itemId: req.params.id, itemName: name, action: "sent_to_client", actorId: actor.id, actorName: actor.name, detail: how + (to ? " to " + to : "") });
  res.json({ ok: true });
}));

// ---- rename / move / delete (to the recycle bin) -----------------------------------------------------------------
router.patch("/item/:id", safeHandler(async (req: any, res: any) => {
  const { cleanLibraryName } = await import("./o365.js");
  const name = cleanLibraryName(req.body?.name);
  if (!name) return res.status(400).json({ error: "name_required", message: "Give it a name." });
  const c = await ctx(req, res); if (!c) return;
  try {
    const item = await libraryItem(c, String(req.params.id));
    const updated = await g.patchItem(c.graph, c.lib.drive_id, item.id, { name });
    await repo.renameEverywhere(item.id, updated.name);
    await repo.logActivity({ itemId: item.id, itemName: updated.name, isFolder: !!item.folder, action: "renamed", actorId: c.actor.id, actorName: c.actor.name, detail: "was " + item.name });
    res.json({ ok: true, item: g.mapLibraryItem(updated) });
  } catch (err) { sendError(res, err); }
}));

router.post("/item/:id/move", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  try {
    const item = await libraryItem(c, String(req.params.id));
    const to = String(req.body?.folderId ?? "") || c.lib.item_id;
    if (!g.isItemId(to) || to === item.id) return res.status(400).json({ error: "bad_folder", message: "Pick another folder." });
    let dest: any = { id: c.lib.item_id, name: "Staff Library", folder: {} };
    if (to !== c.lib.item_id) dest = await libraryItem(c, to);
    if (!dest.folder) return res.status(400).json({ error: "bad_folder", message: "Move it into a folder." });
    if (to === c.lib.trash_item_id) return res.status(400).json({ error: "bad_folder", message: "Use Delete instead." });
    const moved = await g.patchItem(c.graph, c.lib.drive_id, item.id, { parentReference: { id: to } }, true);
    await repo.logActivity({ itemId: item.id, itemName: moved.name, isFolder: !!item.folder, action: "moved", actorId: c.actor.id, actorName: c.actor.name, detail: "to " + dest.name });
    res.json({ ok: true, item: g.mapLibraryItem(moved) });
  } catch (err) { sendError(res, err); }
}));

router.delete("/item/:id", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  try {
    const item = await libraryItem(c, String(req.params.id));
    const bin = await trashFolderId(c);
    if (item.id === bin) return res.status(400).json({ error: "bad_item", message: "The recycle bin can't be deleted." });
    await g.patchItem(c.graph, c.lib.drive_id, item.id, { parentReference: { id: bin } }, true);
    await repo.addTrash({ itemId: item.id, itemName: item.name, isFolder: !!item.folder, originalParentId: item.parentReference?.id ?? c.lib.item_id, originalPath: item.parentReference?.path ?? null, deletedBy: c.actor.id, deletedByName: c.actor.name });
    await repo.logActivity({ itemId: item.id, itemName: item.name, isFolder: !!item.folder, action: "deleted", actorId: c.actor.id, actorName: c.actor.name });
    await purgeExpired(c);
    res.json({ ok: true, restoreDays: repo.TRASH_DAYS });
  } catch (err) { sendError(res, err); }
}));

router.get("/trash", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  await purgeExpired(c);
  res.json({ items: await repo.listTrash(), days: repo.TRASH_DAYS });
}));

router.post("/trash/:id/restore", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  const t = await repo.getTrash(String(req.params.id));
  if (!t) return res.status(404).json({ error: "not_found", message: "It isn't in the recycle bin." });
  try {
    let parent = t.original_parent_id;
    const parentOk = parent === c.lib.item_id || await g.getItem(c.graph, c.lib.drive_id, parent).then((p) => !inTrash(c, p)).catch(() => false);
    if (!parentOk) parent = c.lib.item_id; // its folder is gone: put it back at the top of the library
    const back = await g.patchItem(c.graph, c.lib.drive_id, t.item_id, { parentReference: { id: parent }, name: t.item_name }, true);
    await repo.removeTrash(t.item_id);
    await repo.logActivity({ itemId: t.item_id, itemName: back.name, isFolder: t.is_folder, action: "restored", actorId: c.actor.id, actorName: c.actor.name });
    res.json({ ok: true, item: g.mapLibraryItem(back), toTop: parent !== t.original_parent_id });
  } catch (err) { sendError(res, err); }
}));

router.delete("/trash/:id", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  const t = await repo.getTrash(String(req.params.id));
  if (!t) return res.status(404).json({ error: "not_found" });
  try {
    await g.deleteItem(c.graph, c.lib.drive_id, t.item_id);
    await repo.removeTrash(t.item_id);
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
}));

// ---- stars, recent, activity -------------------------------------------------------------------------------------
router.get("/stars", safeHandler(async (req: any, res: any) => {
  const a = actorOf(req); if (!a.id) return res.status(401).json({ error: "unauthenticated" });
  res.json({ items: await repo.listStars(a.id) });
}));
router.put("/item/:id/star", safeHandler(async (req: any, res: any) => {
  const a = actorOf(req); if (!a.id) return res.status(401).json({ error: "unauthenticated" });
  const name = String(req.body?.name ?? "").slice(0, 300);
  if (!g.isItemId(req.params.id) || !name) return res.status(400).json({ error: "bad_request" });
  await repo.setStar(a.id, { id: req.params.id, name, isFolder: req.body?.isFolder === true }, req.body?.starred !== false);
  res.json({ ok: true, starred: req.body?.starred !== false });
}));
router.get("/recent", safeHandler(async (_req: any, res: any) => {
  res.json({ items: await repo.listRecent(30) });
}));
router.get("/activity", safeHandler(async (_req: any, res: any) => {
  res.json({ items: await repo.listActivity(150) });
}));

// ---- version history --------------------------------------------------------------------------------------------
router.get("/item/:id/versions", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  try {
    const item = await libraryItem(c, String(req.params.id));
    res.json({ versions: await g.listVersions(c.graph, c.lib.drive_id, item.id) });
  } catch (err) { sendError(res, err); }
}));
router.post("/item/:id/versions/:vid/restore", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  const vid = String(req.params.vid ?? "");
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(vid)) return res.status(400).json({ error: "bad_version" });
  try {
    const item = await libraryItem(c, String(req.params.id));
    await g.restoreVersion(c.graph, c.lib.drive_id, item.id, vid);
    await repo.logActivity({ itemId: item.id, itemName: item.name, action: "restored_version", actorId: c.actor.id, actorName: c.actor.name, detail: "version " + vid });
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
}));

// ---- share links for people outside Boreal -----------------------------------------------------------------------
router.post("/item/:id/share", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  const password = typeof req.body?.password === "string" && req.body.password.trim() ? req.body.password.trim().slice(0, 100) : null;
  if (password && password.length < 4) return res.status(400).json({ error: "password_short", message: "Use at least 4 characters for the password." });
  try {
    const item = await libraryItem(c, String(req.params.id));
    if (item.folder) return res.status(400).json({ error: "not_a_file", message: "Share links are for files. Download the folder as a zip to send it." });
    const days = clampDays(req.body?.expiresDays, 7);
    const link = await repo.createShareLink({ itemId: item.id, itemName: item.name, allowDownload: req.body?.allowDownload !== false, password, expiresDays: days, createdBy: c.actor.id, createdByName: c.actor.name });
    await repo.logActivity({ itemId: item.id, itemName: item.name, action: "shared_link", actorId: c.actor.id, actorName: c.actor.name, detail: days + " days" + (password ? ", password" : "") });
    res.json({ ok: true, id: link.id, url: publicBase() + "/api/shared/f/" + link.token, expiresAt: link.expiresAt });
  } catch (err) { sendError(res, err); }
}));
router.get("/shares", safeHandler(async (_req: any, res: any) => {
  res.json({ items: await repo.listShareLinks() });
}));
router.delete("/shares/:id", safeHandler(async (req: any, res: any) => {
  res.json({ ok: await repo.revokeShareLink(String(req.params.id)) });
}));

// ---- file requests (upload links) --------------------------------------------------------------------------------
router.post("/requests", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  const title = String(req.body?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 150);
  if (!title) return res.status(400).json({ error: "title_required", message: "Say what you're asking for." });
  try {
    const folderId = String(req.body?.folderId ?? "") || c.lib.item_id;
    const folder = folderId === c.lib.item_id ? { id: c.lib.item_id, name: "Staff Library", folder: {} } : await libraryItem(c, folderId);
    if (!folder.folder || folder.id === c.lib.trash_item_id) return res.status(400).json({ error: "bad_folder", message: "Pick a folder for the uploads." });
    const days = clampDays(req.body?.expiresDays, 14);
    const r = await repo.createFileRequest({ folderId: folder.id, folderName: folder.name, title, expiresDays: days, createdBy: c.actor.id, createdByName: c.actor.name });
    await repo.logActivity({ itemId: folder.id, itemName: folder.name, isFolder: true, action: "requested_files", actorId: c.actor.id, actorName: c.actor.name, detail: title });
    res.json({ ok: true, id: r.id, url: publicBase() + "/api/shared/r/" + r.token, expiresAt: r.expiresAt });
  } catch (err) { sendError(res, err); }
}));
router.get("/requests", safeHandler(async (_req: any, res: any) => {
  res.json({ items: await repo.listFileRequests() });
}));
router.delete("/requests/:id", safeHandler(async (req: any, res: any) => {
  res.json({ ok: await repo.closeFileRequest(String(req.params.id)) });
}));

// ---- download a folder as a zip ----------------------------------------------------------------------------------
router.get("/zip", safeHandler(async (req: any, res: any) => {
  const c = await ctx(req, res); if (!c) return;
  const folderId = typeof req.query?.item === "string" && req.query.item ? req.query.item : c.lib.item_id;
  let rootName = "Staff Library";
  const files: Array<{ path: string; url: string; size: number }> = [];
  try {
    if (folderId !== c.lib.item_id) {
      const f = await libraryItem(c, folderId);
      if (!f.folder) return res.status(400).json({ error: "not_a_folder" });
      rootName = f.name;
    }
    let total = 0;
    const walk = async (id: string, prefix: string): Promise<void> => {
      for (const child of await g.listChildren(c.graph, c.lib.drive_id, id)) {
        if (inTrash(c, child)) continue;
        if (child.folder) { await walk(child.id, prefix + child.name + "/"); continue; }
        total += Number(child.size ?? 0);
        if (files.length >= ZIP_MAX_FILES || total > ZIP_MAX_BYTES) throw new g.LibraryGraphError(413, "too_large", "That folder is too big to zip here (over 1,000 files or 500 MB). Open it in OneDrive instead.");
        if (child["@microsoft.graph.downloadUrl"]) files.push({ path: prefix + child.name, url: child["@microsoft.graph.downloadUrl"], size: Number(child.size ?? 0) });
      }
    };
    await walk(folderId, "");
  } catch (err) { return sendError(res, err); }
  const safe = rootName.replace(/[^\w .-]+/g, "_").slice(0, 80) || "folder";
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}.zip"`);
  const zip = archiver("zip", { zlib: { level: 6 } });
  zip.on("warning", (e: unknown) => console.warn("[staff-library] zip warning", e instanceof Error ? e.message : String(e)));
  zip.on("error", (e: unknown) => { console.error("[staff-library] zip failed", e instanceof Error ? e.message : String(e)); res.destroy(); });
  zip.pipe(res);
  for (const f of files) {
    const got = await fetch(f.url);
    if (!got.ok || !got.body) { console.warn("[staff-library] zip file skipped", { path: f.path, status: got.status }); continue; }
    zip.append(Readable.fromWeb(got.body as any), { name: f.path });
    await new Promise<void>((resolve) => zip.once("entry", () => resolve()));
  }
  await repo.logActivity({ itemId: folderId, itemName: rootName, isFolder: true, action: "downloaded_zip", actorId: c.actor.id, actorName: c.actor.name, detail: files.length + " files" });
  await zip.finalize();
}));

export default router;
