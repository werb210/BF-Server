// BF_SERVER_v937_SOCIAL_POSTING - /api/social: connect social accounts, then write one post and publish or schedule it
// to any of them. Each silo has its own accounts and posts.
//   GET    /callback/:provider          PUBLIC - the network sends the browser back here after sign-in
//   GET    /accounts                    connected accounts + which networks are set up on the server
//   POST   /connect/:provider           Admin / Marketing: { url } to the network's sign-in page
//   POST   /connect/bluesky             Admin / Marketing: { handle, appPassword }
//   DELETE /accounts/:id                Admin / Marketing
//   GET    /posts                       recent and scheduled posts with each account's result
//   POST   /posts                       Admin / Marketing: { body, link_url?, image_url?, account_ids, scheduled_at? }
//                                        no scheduled_at -> published now and the results returned
//   DELETE /posts/:id                   cancel a scheduled post
//   POST   /media                       Admin / Marketing: multipart "file" (image) -> { url } to use as image_url
import { Router } from "express";
import multer from "multer";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { socialCryptoReady } from "../social/crypto.js";
import { NETWORKS, NETWORK_LABEL, PROVIDERS, PROVIDER_OF, authorizeUrl, blueskyAccount, exchange, pkcePair, providerConfigured, providerSettings, type Provider } from "../social/networks.js";
import { cancelPost, createPost, listAccounts, listPosts, publishPost, removeAccount, saveAccounts } from "../social/service.js";

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const userIdOf = (req: any) => { const v = String(req.user?.userId ?? req.user?.id ?? ""); return UUID.test(v) ? v : null; };
const serverBase = () => String(process.env.PUBLIC_BASE_URL || process.env.SERVER_URL || "https://server.boreal.financial").replace(/\/+$/, "");
const portalBase = () => String(process.env.PORTAL_URL || "https://staff.boreal.financial").replace(/\/+$/, "");
const redirectUri = (p: Provider) => `${serverBase()}/api/social/callback/${p}`;
const back = (outcome: "connected" | "error", why = "") => `${portalBase()}/marketing?tab=social&social=${outcome}${why ? `&why=${encodeURIComponent(why.slice(0, 160))}` : ""}`;
const isProvider = (v: string): v is Exclude<Provider, "bluesky"> => (PROVIDERS as string[]).includes(v) && v !== "bluesky";

router.get("/callback/:provider", safeHandler(async (req: any, res: any) => {
  const p = String(req.params.provider);
  if (!isProvider(p)) return res.redirect(back("error", "Unknown network."));
  if (typeof req.query.error === "string") return res.redirect(back("error", String(req.query.error_description ?? "The sign-in was cancelled.")));
  let st: { uid: string | null; silo: string; p: string; v?: string };
  try { st = jwt.verify(String(req.query.state ?? ""), String(process.env.JWT_SECRET), { algorithms: ["HS256"] }) as any; }
  catch { return res.redirect(back("error", "The sign-in took too long. Try Connect again.")); }
  if (st.p !== p) return res.redirect(back("error", "The sign-in did not match. Try Connect again."));
  try {
    const accounts = await exchange(p, String(req.query.code ?? ""), redirectUri(p), st.v);
    await saveAccounts(pool as any, st.silo, accounts, st.uid);
    return res.redirect(back("connected"));
  } catch (err) {
    console.warn("[social] connect failed", { provider: p, message: err instanceof Error ? err.message : String(err) });
    return res.redirect(back("error", err instanceof Error ? err.message : "The connection failed."));
  }
}));

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.MARKETING_VIEW]));
const canPost = (req: any, res: any, next: any) => (["Admin", "Marketing"].includes(String(req.user?.role)) ? next() : res.status(403).json({ ok: false, error: "forbidden", message: "Only Admin and Marketing can do this." }));
const needCrypto = (_req: any, res: any, next: any) => (socialCryptoReady() ? next() : res.status(409).json({ ok: false, error: "not_configured", message: "Social posting is not set up on the server yet (SOCIAL_TOKEN_ENCRYPTION_KEY)." }));

router.get("/accounts", safeHandler(async (req: any, res: any) => {
  res.json({
    ok: true,
    ready: socialCryptoReady(),
    networks: NETWORKS.map((n) => ({ key: n, label: NETWORK_LABEL[n], provider: PROVIDER_OF[n], configured: providerConfigured(PROVIDER_OF[n]), settings: providerSettings(PROVIDER_OF[n]) })),
    accounts: await listAccounts(pool as any, resolveSiloFromRequest(req)),
  });
}));

router.post("/connect/bluesky", canPost, needCrypto, safeHandler(async (req: any, res: any) => {
  const handle = String(req.body?.handle ?? "").trim().replace(/^@/, "");
  const pw = String(req.body?.appPassword ?? "").trim();
  if (!handle || !pw) return res.status(400).json({ ok: false, error: "validation_error", message: "Enter the Bluesky handle and an app password." });
  try {
    const acc = await blueskyAccount(handle, pw);
    await saveAccounts(pool as any, resolveSiloFromRequest(req), [acc], userIdOf(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: "connect_failed", message: `Bluesky did not accept that: ${err instanceof Error ? err.message : String(err)}. Use an app password (Bluesky Settings > Privacy and security > App passwords).` });
  }
}));

router.post("/connect/:provider", canPost, needCrypto, safeHandler(async (req: any, res: any) => {
  const p = String(req.params.provider);
  if (!isProvider(p)) return res.status(404).json({ ok: false, error: "not_found" });
  if (!providerConfigured(p)) return res.status(409).json({ ok: false, error: "not_configured", message: `This network is not set up on the server yet (${providerSettings(p).join(", ")}).` });
  const pk = p === "x" ? pkcePair() : null;
  const state = jwt.sign({ uid: userIdOf(req), silo: resolveSiloFromRequest(req), p, ...(pk ? { v: pk.verifier } : {}) }, String(process.env.JWT_SECRET), { expiresIn: "10m" });
  res.json({ ok: true, url: authorizeUrl(p, redirectUri(p), state, pk?.challenge) });
}));

router.delete("/accounts/:id", canPost, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!UUID.test(id) || !(await removeAccount(pool as any, resolveSiloFromRequest(req), id))) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true });
}));

router.get("/posts", safeHandler(async (req: any, res: any) => {
  res.json({ ok: true, posts: await listPosts(pool as any, resolveSiloFromRequest(req)) });
}));

router.post("/posts", canPost, needCrypto, safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const body = String(b.body ?? "").trim();
  if (!body) return res.status(400).json({ ok: false, error: "validation_error", message: "Write the post." });
  if (body.length > 5000) return res.status(400).json({ ok: false, error: "validation_error", message: "That post is too long." });
  const url = (v: unknown) => { const s = String(v ?? "").trim(); return /^https:\/\/\S+$/i.test(s) ? s : null; };
  const image = (v: unknown) => { const s = String(v ?? "").trim(); return /^blob:image\/(jpeg|png|gif|webp):\S+$/.test(s) ? s : url(s); };
  const ids = Array.isArray(b.account_ids) ? b.account_ids.map(String).filter((x: string) => UUID.test(x)) : [];
  let when: Date | null = null;
  if (b.scheduled_at) {
    when = new Date(String(b.scheduled_at));
    if (Number.isNaN(when.getTime())) return res.status(400).json({ ok: false, error: "validation_error", message: "That time is not a real date." });
    if (when.getTime() < Date.now() + 60_000) when = null; // a time in the past (or now) means post now
  }
  const silo = resolveSiloFromRequest(req);
  try {
    const post = await createPost(pool as any, silo, { body, link_url: url(b.link_url), image_url: image(b.image_url), account_ids: ids, scheduled_at: when }, userIdOf(req));
    if (when) return res.status(201).json({ ok: true, post });
    return res.status(201).json({ ok: true, post: await publishPost(pool as any, post.id) });
  } catch (err: any) {
    if (err?.status === 400) return res.status(400).json({ ok: false, error: "validation_error", message: err.message });
    throw err;
  }
}));

router.delete("/posts/:id", canPost, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!UUID.test(id) || !(await cancelPost(pool as any, resolveSiloFromRequest(req), id))) return res.status(404).json({ ok: false, error: "not_found", message: "Only a scheduled post can be cancelled." });
  res.json({ ok: true });
}));

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
router.post("/media", canPost, imageUpload.single("file"), safeHandler(async (req: any, res: any) => {
  const f = req.file as { buffer: Buffer; originalname: string; mimetype: string } | undefined;
  if (!f?.buffer?.length || !/^image\/(jpeg|png|gif|webp)$/.test(f.mimetype)) return res.status(400).json({ ok: false, error: "validation_error", message: "Choose a JPG, PNG, GIF or WebP picture (8 MB at most)." });
  const { getStorage } = await import("../lib/storage/index.js");
  const store = getStorage();
  const put = await store.put({ buffer: f.buffer, filename: f.originalname, contentType: f.mimetype, pathPrefix: `social/${resolveSiloFromRequest(req)}` });
  // Review fix: the post keeps a reference to the stored picture ("blob:<type>:<name>"), and a fresh link (served as
  // the picture's own type) is made when the post goes out, so a post scheduled weeks ahead still has a working picture.
  const preview = (await store.getSignedUrl?.(put.blobName, 3600, f.mimetype)) ?? put.url;
  res.status(201).json({ ok: true, url: `blob:${f.mimetype}:${put.blobName}`, preview });
}));

export default router;
