// BF_SERVER_v810_LIBRARY_PLUS - the public side of the Staff Library, for people outside Boreal (no sign-in):
//   /api/shared/f/:token  a share link: view or download one file, until it expires; optional password.
//   /api/shared/r/:token  a file request: upload files into one library folder, until it expires.
// The file moves through this server with the Microsoft sign-in of the staff member who made the link.
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { Readable } from "node:stream";
import { safeHandler } from "../middleware/safeHandler.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { pool } from "../db.js";
import { getGraphForUser } from "../modules/o365/graphClient.js";
import * as repo from "../modules/library/library.repo.js";
import * as g from "../modules/library/libraryGraph.js";

const router = Router();
export const REQUEST_MAX_FILE_BYTES = 50 * 1024 * 1024;
const CHUNK = 16 * 320 * 1024;

const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req: any) => rateLimitKeyFromRequest(req) }) as any;
router.use(limiter);

export function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function humanSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
// One plain, readable page: dark text on white, Boreal Financial named as the sender.
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} - Boreal Financial</title>
<style>body{margin:0;background:#f1f5f9;color:#0f172a;font:16px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif}
main{max-width:560px;margin:40px auto;padding:28px;background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(15,23,42,.08)}
h1{font-size:22px;margin:0 0 6px}p{margin:8px 0}.muted{color:#475569;font-size:14px}.brand{font-weight:800;color:#1e3a8a;margin-bottom:18px}
.btn{display:inline-block;background:#1e3a8a;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px;font-weight:700;text-decoration:none;cursor:pointer}
input[type=password],input[type=text],input[type=email]{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #94a3b8;border-radius:8px;font-size:16px;margin:6px 0 12px;color:#0f172a}
.err{color:#991b1b;font-weight:600}.ok{color:#065f46;font-weight:600}</style></head>
<body><main><div class="brand">Boreal Financial</div>${body}<p class="muted" style="margin-top:24px">Questions? Call (866) 631-8939 or email info@boreal.financial.</p></main></body></html>`;
}
function gone(res: any, what: string): void {
  res.status(410).type("html").send(page("Link no longer available", `<h1>This ${what} has ended</h1><p>The link has expired or was turned off. Ask the person at Boreal Financial who sent it for a new one.</p>`));
}

async function shareFor(token: string): Promise<any | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const s = await repo.findShareLink(token);
  if (!s || s.revoked_at || new Date(s.expires_at).getTime() <= Date.now()) return null;
  return s;
}

// ---- share links -------------------------------------------------------------------------------------------------
router.get("/f/:token", safeHandler(async (req: any, res: any) => {
  const s = await shareFor(String(req.params.token));
  if (!s) return gone(res, "share link");
  const action = "/api/shared/f/" + encodeURIComponent(req.params.token) + "/file";
  const until = new Date(s.expires_at).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  const pw = s.password_hash ? `<label for="p">Password</label><input id="p" type="password" name="password" required autocomplete="off">` : "";
  const buttons = (s.allow_download ? `<button class="btn" type="submit" name="mode" value="download">Download</button> ` : "")
    + `<button class="btn" type="submit" name="mode" value="view" style="background:#0f766e">View</button>`;
  res.type("html").send(page(s.item_name, `<h1>${esc(s.item_name)}</h1>
<p class="muted">Shared with you by ${esc(s.created_by_name ?? "Boreal Financial")}. Available until ${esc(until)}.</p>
<form method="post" action="${esc(action)}">${pw}<p>${buttons}</p></form>`));
}));

router.post("/f/:token/file", express.urlencoded({ extended: false, limit: "10kb" }), safeHandler(async (req: any, res: any) => {
  const s = await shareFor(String(req.params.token));
  if (!s) return gone(res, "share link");
  if (!repo.passwordMatches(String(req.body?.password ?? ""), s.password_hash)) {
    return res.status(401).type("html").send(page("Wrong password", `<h1>${esc(s.item_name)}</h1><p class="err">That password isn't right.</p><p><a href="/api/shared/f/${esc(req.params.token)}">Try again</a></p>`));
  }
  const mode = req.body?.mode === "download" && s.allow_download ? "attachment" : "inline";
  const lib = await repo.getLibrary();
  const graph = lib?.drive_id ? await getGraphForUser(pool, s.created_by) : null;
  if (!lib?.drive_id || !graph) return gone(res, "share link");
  try {
    const d = await g.downloadUrl(graph, lib.drive_id, s.item_id);
    const got = await fetch(d.url);
    if (!got.ok || !got.body) return gone(res, "share link");
    await repo.countShareOpen(s.id).catch((err: unknown) => console.warn("[shared] open not counted", err instanceof Error ? err.message : String(err)));
    res.setHeader("Content-Type", d.mimeType);
    res.setHeader("Content-Disposition", `${mode}; filename*=UTF-8''${encodeURIComponent(d.name)}`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (mode === "inline") res.setHeader("Content-Security-Policy", "sandbox");
    Readable.fromWeb(got.body as any).pipe(res);
  } catch (err) {
    console.warn("[shared] file failed", { id: s.id, message: err instanceof Error ? err.message : String(err) });
    gone(res, "share link");
  }
}));

// ---- file requests -----------------------------------------------------------------------------------------------
async function requestFor(token: string): Promise<any | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const r = await repo.findFileRequest(token);
  if (!r || r.closed_at || new Date(r.expires_at).getTime() <= Date.now()) return null;
  return r;
}

router.get("/r/:token", safeHandler(async (req: any, res: any) => {
  const r = await requestFor(String(req.params.token));
  if (!r) return gone(res, "upload link");
  const post = "/api/shared/r/" + encodeURIComponent(req.params.token) + "/upload";
  const until = new Date(r.expires_at).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  res.type("html").send(page(r.title, `<h1>${esc(r.title)}</h1>
<p class="muted">${esc(r.created_by_name ?? "Boreal Financial")} asked you to upload files. Open until ${esc(until)}. Up to 50 MB per file.</p>
<label for="n">Your name</label><input id="n" type="text" maxlength="100" autocomplete="name">
<input id="f" type="file" multiple style="margin:6px 0 14px">
<p><button class="btn" id="go" type="button">Upload</button></p><p id="s" role="status"></p>
<script>
(function(){var go=document.getElementById('go'),f=document.getElementById('f'),s=document.getElementById('s'),n=document.getElementById('n');
go.onclick=async function(){var files=f.files;if(!files||!files.length){s.className='err';s.textContent='Choose at least one file.';return;}
go.disabled=true;var done=0,bad=[];for(var i=0;i<files.length;i++){var x=files[i];s.className='';s.textContent='Uploading '+x.name+' ('+(i+1)+' of '+files.length+')...';
if(x.size>${REQUEST_MAX_FILE_BYTES}){bad.push(x.name+' (over 50 MB)');continue;}
try{var r=await fetch(${JSON.stringify(post)},{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(x.name),'X-Uploader':encodeURIComponent(n.value||'')},body:x});if(r.ok)done++;else bad.push(x.name);}catch(e){bad.push(x.name);}}
go.disabled=false;f.value='';s.className=bad.length?'err':'ok';s.textContent=(done?done+' file(s) uploaded. Thank you.':'')+(bad.length?' Not uploaded: '+bad.join(', ')+'.':'');};})();
</script>`));
}));

router.post("/r/:token/upload", express.raw({ type: "application/octet-stream", limit: REQUEST_MAX_FILE_BYTES }), safeHandler(async (req: any, res: any) => {
  const r = await requestFor(String(req.params.token));
  if (!r) return res.status(410).json({ error: "link_ended" });
  const { cleanLibraryName } = await import("./o365.js");
  let raw = "";
  try { raw = decodeURIComponent(String(req.headers["x-file-name"] ?? "")); } catch { raw = ""; }
  const name = cleanLibraryName(raw);
  const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!name || !body.length) return res.status(400).json({ error: "bad_file" });
  let uploader = "";
  try { uploader = decodeURIComponent(String(req.headers["x-uploader"] ?? "")).replace(/\s+/g, " ").trim().slice(0, 100); } catch { uploader = ""; }
  const lib = await repo.getLibrary();
  const graph = lib?.drive_id ? await getGraphForUser(pool, r.created_by) : null;
  if (!lib?.drive_id || !graph) return res.status(503).json({ error: "not_available" });
  try {
    const item = await g.uploadBuffer(graph, lib.drive_id, r.folder_id, name, body, CHUNK);
    await repo.countRequestUpload(r.id);
    const who = uploader || "Someone";
    await repo.logActivity({ itemId: String(item.id), itemName: String(item.name), action: "received_upload", actorName: who + " (upload link)", detail: r.title });
    await repo.notifyStaff(r.created_by, String(item.id), "New file: " + item.name, who + " uploaded " + item.name + " to " + r.folder_name + " (" + r.title + ")" + (body.length ? ", " + humanSize(body.length) : "") + ".");
    res.json({ ok: true });
  } catch (err) {
    console.warn("[shared] request upload failed", { id: r.id, message: err instanceof Error ? err.message : String(err) });
    res.status(502).json({ error: "upload_failed" });
  }
}));

export default router;
