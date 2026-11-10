// BF_SERVER_v937_SOCIAL_POSTING - each network: is it set up, the sign-in link, turning the sign-in into accounts,
// and publishing one post. Every call goes through `http` so tests can answer without the network.
import crypto from "node:crypto";

export type Network = "facebook" | "instagram" | "threads" | "linkedin" | "x" | "google_business" | "bluesky";
export const NETWORKS: Network[] = ["facebook", "instagram", "threads", "linkedin", "x", "google_business", "bluesky"];
export const NETWORK_LABEL: Record<Network, string> = {
  facebook: "Facebook", instagram: "Instagram", threads: "Threads", linkedin: "LinkedIn", x: "X", google_business: "Google Business Profile", bluesky: "Bluesky",
};
/** Which sign-in connects a network ("meta" connects Facebook pages and their Instagram accounts together). */
export type Provider = "meta" | "threads" | "linkedin" | "x" | "google" | "bluesky";
export const PROVIDER_OF: Record<Network, Provider> = { facebook: "meta", instagram: "meta", threads: "threads", linkedin: "linkedin", x: "x", google_business: "google", bluesky: "bluesky" };
export const PROVIDERS: Provider[] = ["meta", "threads", "linkedin", "x", "google", "bluesky"];

const env = (k: string) => String(process.env[k] ?? "").trim();
const CREDS: Record<Exclude<Provider, "bluesky">, [string, string]> = {
  meta: ["META_APP_ID", "META_APP_SECRET"],
  threads: ["THREADS_APP_ID", "THREADS_APP_SECRET"],
  linkedin: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  x: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
  google: ["GOOGLE_BUSINESS_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_SECRET"],
};
export function providerSettings(p: Provider): string[] { return p === "bluesky" ? [] : CREDS[p]; }
export function providerConfigured(p: Provider): boolean { return p === "bluesky" || CREDS[p].every((k) => env(k)); }
const id = (p: Exclude<Provider, "bluesky">) => env(CREDS[p][0]);
const secret = (p: Exclude<Provider, "bluesky">) => env(CREDS[p][1]);

export type Http = (url: string, init?: RequestInit) => Promise<Response>;
export const defaultHttp: Http = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });

async function json(http: Http, url: string, init?: RequestInit): Promise<any> {
  const res = await http(url, init);
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.error_description ?? body?.detail ?? body?.message ?? body?.title ?? (typeof body?.error === "string" ? body.error : "") ?? "";
    throw Object.assign(new Error(String(msg || `HTTP ${res.status}`).slice(0, 300)), { status: res.status });
  }
  return body;
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

const META_V = "v21.0";
const META_SCOPES = "pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish,business_management";

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

/** The network's sign-in page. */
export function authorizeUrl(p: Exclude<Provider, "bluesky">, redirectUri: string, state: string, challenge?: string): string {
  const q = (base: string, o: Record<string, string>) => `${base}?${new URLSearchParams(o)}`;
  switch (p) {
    case "meta": return q(`https://www.facebook.com/${META_V}/dialog/oauth`, { client_id: id(p), redirect_uri: redirectUri, state, scope: META_SCOPES, response_type: "code" });
    case "threads": return q("https://threads.net/oauth/authorize", { client_id: id(p), redirect_uri: redirectUri, state, scope: "threads_basic,threads_content_publish", response_type: "code" });
    case "linkedin": return q("https://www.linkedin.com/oauth/v2/authorization", { response_type: "code", client_id: id(p), redirect_uri: redirectUri, state, scope: "openid profile w_member_social w_organization_social r_organization_social" });
    case "x": return q("https://x.com/i/oauth2/authorize", { response_type: "code", client_id: id(p), redirect_uri: redirectUri, state, scope: "tweet.read tweet.write users.read media.write offline.access", code_challenge: challenge ?? "", code_challenge_method: "S256" });
    case "google": return q("https://accounts.google.com/o/oauth2/v2/auth", { client_id: id(p), redirect_uri: redirectUri, state, scope: "https://www.googleapis.com/auth/business.manage", response_type: "code", access_type: "offline", prompt: "consent" });
  }
}

export type NewAccount = { network: Network; external_id: string; name: string; access_token: string; refresh_token?: string | null; expires_at?: Date | null; meta?: Record<string, unknown> };
const inSeconds = (s: unknown) => (Number(s) > 0 ? new Date(Date.now() + Number(s) * 1000) : null);

/** Turns a finished sign-in into the accounts it gives access to. */
export async function exchange(p: Exclude<Provider, "bluesky">, code: string, redirectUri: string, verifier: string | undefined, http: Http = defaultHttp): Promise<NewAccount[]> {
  if (p === "meta") {
    const short = await json(http, `https://graph.facebook.com/${META_V}/oauth/access_token?${new URLSearchParams({ client_id: id(p), client_secret: secret(p), redirect_uri: redirectUri, code })}`);
    const long = await json(http, `https://graph.facebook.com/${META_V}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: id(p), client_secret: secret(p), fb_exchange_token: short.access_token })}`);
    const pages = await json(http, `https://graph.facebook.com/${META_V}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token,instagram_business_account{id,username}", access_token: long.access_token, limit: "100" })}`);
    const out: NewAccount[] = [];
    for (const pg of pages?.data ?? []) {
      out.push({ network: "facebook", external_id: String(pg.id), name: String(pg.name), access_token: String(pg.access_token) });
      const ig = pg.instagram_business_account;
      if (ig?.id) out.push({ network: "instagram", external_id: String(ig.id), name: `@${ig.username ?? pg.name}`, access_token: String(pg.access_token), meta: { page_id: String(pg.id) } });
    }
    if (!out.length) throw new Error("No Facebook Pages came back. Choose at least one Page when Facebook asks.");
    return out;
  }
  if (p === "threads") {
    const short = await json(http, "https://graph.threads.net/oauth/access_token", { method: "POST", headers: FORM, body: form({ client_id: id(p), client_secret: secret(p), grant_type: "authorization_code", redirect_uri: redirectUri, code }) });
    const long = await json(http, `https://graph.threads.net/access_token?${new URLSearchParams({ grant_type: "th_exchange_token", client_secret: secret(p), access_token: short.access_token })}`);
    const me = await json(http, `https://graph.threads.net/v1.0/me?${new URLSearchParams({ fields: "id,username", access_token: long.access_token })}`);
    return [{ network: "threads", external_id: String(me.id ?? short.user_id), name: `@${me.username ?? "threads"}`, access_token: long.access_token, expires_at: inSeconds(long.expires_in) }];
  }
  if (p === "linkedin") {
    const tok = await json(http, "https://www.linkedin.com/oauth/v2/accessToken", { method: "POST", headers: FORM, body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: id(p), client_secret: secret(p) }) });
    const me = await json(http, "https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const base = { access_token: tok.access_token, refresh_token: tok.refresh_token ?? null, expires_at: inSeconds(tok.expires_in) };
    const out: NewAccount[] = [{ network: "linkedin", external_id: `urn:li:person:${me.sub}`, name: String(me.name ?? "LinkedIn profile"), ...base }];
    // Company pages need LinkedIn's Community Management approval; without it this call is refused and only the profile is added.
    try {
      const acl = await json(http, "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED", { headers: { Authorization: `Bearer ${tok.access_token}`, "LinkedIn-Version": "202405", "X-Restli-Protocol-Version": "2.0.0" } });
      for (const el of acl?.elements ?? []) {
        const org = String(el.organization ?? "");
        const orgId = org.split(":").pop();
        if (!orgId) continue;
        const info = await json(http, `https://api.linkedin.com/rest/organizations/${orgId}`, { headers: { Authorization: `Bearer ${tok.access_token}`, "LinkedIn-Version": "202405" } });
        out.push({ network: "linkedin", external_id: org, name: `${info.localizedName ?? "Company page"} (page)`, ...base });
      }
    } catch (err) {
      console.warn("[social] LinkedIn pages not listed (needs Community Management approval)", { message: err instanceof Error ? err.message : String(err) });
    }
    return out;
  }
  if (p === "x") {
    const basic = Buffer.from(`${id(p)}:${secret(p)}`).toString("base64");
    const tok = await json(http, "https://api.x.com/2/oauth2/token", { method: "POST", headers: { ...FORM, Authorization: `Basic ${basic}` }, body: form({ code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: verifier ?? "", client_id: id(p) }) });
    const me = await json(http, "https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${tok.access_token}` } });
    return [{ network: "x", external_id: String(me.data?.id), name: `@${me.data?.username ?? "x"}`, access_token: tok.access_token, refresh_token: tok.refresh_token ?? null, expires_at: inSeconds(tok.expires_in) }];
  }
  // google
  const tok = await json(http, "https://oauth2.googleapis.com/token", { method: "POST", headers: FORM, body: form({ code, client_id: id("google"), client_secret: secret("google"), redirect_uri: redirectUri, grant_type: "authorization_code" }) });
  const auth = { Authorization: `Bearer ${tok.access_token}` };
  const accounts = await json(http, "https://mybusinessaccountmanagement.googleapis.com/v1/accounts", { headers: auth });
  const out: NewAccount[] = [];
  for (const a of accounts?.accounts ?? []) {
    const locs = await json(http, `https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title&pageSize=100`, { headers: auth });
    for (const l of locs?.locations ?? []) {
      out.push({ network: "google_business", external_id: `${a.name}/${l.name}`, name: String(l.title ?? "Business location"), access_token: tok.access_token, refresh_token: tok.refresh_token ?? null, expires_at: inSeconds(tok.expires_in) });
    }
  }
  if (!out.length) throw new Error("No Google Business Profile locations came back for that Google account.");
  return out;
}

/** Bluesky has no sign-in page: the handle and an app password (Settings > App passwords in Bluesky). */
export async function blueskyAccount(handle: string, appPassword: string, http: Http = defaultHttp): Promise<NewAccount> {
  const s = await json(http, "https://bsky.social/xrpc/com.atproto.server.createSession", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: handle, password: appPassword }) });
  return { network: "bluesky", external_id: String(s.did), name: `@${s.handle ?? handle}`, access_token: appPassword, meta: { handle: s.handle ?? handle } };
}

export type Live = { network: Network; external_id: string; access_token: string; refresh_token: string | null; expires_at: Date | null; meta: Record<string, any> };
export type Refreshed = { access_token: string; refresh_token?: string | null; expires_at?: Date | null };

/** A fresh token when the stored one has (nearly) run out, or null when it is still good. */
export async function refreshIfNeeded(a: Live, http: Http = defaultHttp): Promise<Refreshed | null> {
  const soon = a.expires_at && a.expires_at.getTime() < Date.now() + 5 * 60 * 1000;
  if (!soon) return null;
  if (a.network === "x" && a.refresh_token) {
    const basic = Buffer.from(`${id("x")}:${secret("x")}`).toString("base64");
    const t = await json(http, "https://api.x.com/2/oauth2/token", { method: "POST", headers: { ...FORM, Authorization: `Basic ${basic}` }, body: form({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: id("x") }) });
    return { access_token: t.access_token, refresh_token: t.refresh_token ?? a.refresh_token, expires_at: inSeconds(t.expires_in) };
  }
  if (a.network === "google_business" && a.refresh_token) {
    const t = await json(http, "https://oauth2.googleapis.com/token", { method: "POST", headers: FORM, body: form({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: id("google"), client_secret: secret("google") }) });
    return { access_token: t.access_token, expires_at: inSeconds(t.expires_in) };
  }
  if (a.network === "threads") {
    const t = await json(http, `https://graph.threads.net/refresh_access_token?${new URLSearchParams({ grant_type: "th_refresh_token", access_token: a.access_token })}`);
    return { access_token: t.access_token, expires_at: inSeconds(t.expires_in) };
  }
  if (a.network === "linkedin" && a.refresh_token) {
    const t = await json(http, "https://www.linkedin.com/oauth/v2/accessToken", { method: "POST", headers: FORM, body: form({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: id("linkedin"), client_secret: secret("linkedin") }) });
    return { access_token: t.access_token, refresh_token: t.refresh_token ?? a.refresh_token, expires_at: inSeconds(t.expires_in) };
  }
  if (a.network === "linkedin") throw new Error("The LinkedIn connection has expired (every 60 days). Connect LinkedIn again.");
  return null;
}

export type PostInput = { text: string; link: string | null; image: string | null };
export type Published = { external_id: string; url: string | null };

async function fetchImage(http: Http, url: string): Promise<{ bytes: Buffer; type: string }> {
  const res = await http(url);
  if (!res.ok) throw new Error("The picture could not be downloaded to attach it.");
  const type = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
  return { bytes: Buffer.from(await res.arrayBuffer()), type };
}

/** The text as one line for networks without a separate link field. */
const withLink = (p: PostInput) => (p.link && !p.text.includes(p.link) ? `${p.text}\n\n${p.link}` : p.text);

export async function publish(a: Live, post: PostInput, http: Http = defaultHttp): Promise<Published> {
  const t = a.access_token;
  switch (a.network) {
    case "facebook": {
      const r = post.image
        ? await json(http, `https://graph.facebook.com/${META_V}/${a.external_id}/photos`, { method: "POST", headers: FORM, body: form({ url: post.image, caption: withLink(post), access_token: t }) })
        : await json(http, `https://graph.facebook.com/${META_V}/${a.external_id}/feed`, { method: "POST", headers: FORM, body: form({ message: post.text, ...(post.link ? { link: post.link } : {}), access_token: t }) });
      const pid = String(r.post_id ?? r.id);
      return { external_id: pid, url: `https://www.facebook.com/${pid}` };
    }
    case "instagram": {
      if (!post.image) throw new Error("Instagram needs a picture. Add one, or untick Instagram for this post.");
      const c = await json(http, `https://graph.facebook.com/${META_V}/${a.external_id}/media`, { method: "POST", headers: FORM, body: form({ image_url: post.image, caption: withLink(post), access_token: t }) });
      const r = await json(http, `https://graph.facebook.com/${META_V}/${a.external_id}/media_publish`, { method: "POST", headers: FORM, body: form({ creation_id: String(c.id), access_token: t }) });
      return { external_id: String(r.id), url: null };
    }
    case "threads": {
      const body: Record<string, string> = post.image ? { media_type: "IMAGE", image_url: post.image, text: withLink(post) } : { media_type: "TEXT", text: withLink(post) };
      const c = await json(http, `https://graph.threads.net/v1.0/${a.external_id}/threads`, { method: "POST", headers: FORM, body: form({ ...body, access_token: t }) });
      const r = await json(http, `https://graph.threads.net/v1.0/${a.external_id}/threads_publish`, { method: "POST", headers: FORM, body: form({ creation_id: String(c.id), access_token: t }) });
      return { external_id: String(r.id), url: null };
    }
    case "linkedin": {
      const liHeaders = { Authorization: `Bearer ${t}`, "Content-Type": "application/json", "LinkedIn-Version": "202405", "X-Restli-Protocol-Version": "2.0.0" };
      let imageUrn: string | null = null;
      if (post.image) {
        const img = await fetchImage(http, post.image);
        const init = await json(http, "https://api.linkedin.com/rest/images?action=initializeUpload", { method: "POST", headers: liHeaders, body: JSON.stringify({ initializeUploadRequest: { owner: a.external_id } }) });
        const put = await http(String(init.value?.uploadUrl), { method: "PUT", headers: { Authorization: `Bearer ${t}`, "Content-Type": img.type }, body: new Uint8Array(img.bytes) });
        if (!put.ok) throw new Error(`LinkedIn did not take the picture (${put.status}).`);
        imageUrn = String(init.value?.image);
      }
      const res = await http("https://api.linkedin.com/rest/posts", {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", "LinkedIn-Version": "202405", "X-Restli-Protocol-Version": "2.0.0" },
        body: JSON.stringify({
          author: a.external_id, commentary: imageUrn && post.link ? withLink(post) : post.text, visibility: "PUBLIC", lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          ...(imageUrn ? { content: { media: { id: imageUrn, title: post.text.split("\n")[0].slice(0, 200) } } }
            : post.link ? { content: { article: { source: post.link, title: post.text.split("\n")[0].slice(0, 200) } } } : {}),
        }),
      });
      if (!res.ok) { const b: any = await res.json().catch(() => ({})); throw new Error(String(b?.message ?? `LinkedIn refused the post (${res.status})`).slice(0, 300)); }
      const urn = res.headers.get("x-restli-id") ?? "";
      return { external_id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : null };
    }
    case "x": {
      let mediaId: string | null = null;
      if (post.image) {
        const img = await fetchImage(http, post.image);
        const fd = new FormData();
        fd.append("media", new Blob([new Uint8Array(img.bytes)], { type: img.type }), "picture");
        fd.append("media_category", "tweet_image");
        const up = await json(http, "https://api.x.com/2/media/upload", { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: fd });
        mediaId = String(up.data?.id ?? up.media_id_string ?? "");
        if (!mediaId) throw new Error("X did not take the picture.");
      }
      const r = await json(http, "https://api.x.com/2/tweets", { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: withLink(post).slice(0, 280), ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) }) });
      return { external_id: String(r.data?.id), url: r.data?.id ? `https://x.com/i/web/status/${r.data.id}` : null };
    }
    case "google_business": {
      const r = await json(http, `https://mybusiness.googleapis.com/v4/${a.external_id}/localPosts`, {
        method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ languageCode: "en", topicType: "STANDARD", summary: post.text.slice(0, 1500), ...(post.link ? { callToAction: { actionType: "LEARN_MORE", url: post.link } } : {}), ...(post.image ? { media: [{ mediaFormat: "PHOTO", sourceUrl: post.image }] } : {}) }),
      });
      return { external_id: String(r.name ?? ""), url: r.searchUrl ?? null };
    }
    case "bluesky": {
      const s = await json(http, "https://bsky.social/xrpc/com.atproto.server.createSession", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: a.meta?.handle ?? a.external_id, password: t }) });
      const text = withLink(post).slice(0, 300);
      const facets: any[] = [];
      if (post.link && text.includes(post.link)) {
        const start = Buffer.byteLength(text.slice(0, text.indexOf(post.link)), "utf8");
        facets.push({ index: { byteStart: start, byteEnd: start + Buffer.byteLength(post.link, "utf8") }, features: [{ $type: "app.bsky.richtext.facet#link", uri: post.link }] });
      }
      let embed: Record<string, unknown> | null = null;
      if (post.image) {
        const img = await fetchImage(http, post.image);
        if (img.bytes.length > 1_000_000) throw new Error("Bluesky takes pictures up to 1 MB. Use a smaller picture.");
        const up = await json(http, "https://bsky.social/xrpc/com.atproto.repo.uploadBlob", { method: "POST", headers: { Authorization: `Bearer ${s.accessJwt}`, "Content-Type": img.type }, body: new Uint8Array(img.bytes) });
        embed = { $type: "app.bsky.embed.images", images: [{ alt: "", image: up.blob }] };
      }
      const r = await json(http, "https://bsky.social/xrpc/com.atproto.repo.createRecord", {
        method: "POST", headers: { Authorization: `Bearer ${s.accessJwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ repo: s.did, collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), ...(facets.length ? { facets } : {}), ...(embed ? { embed } : {}) } }),
      });
      const rkey = String(r.uri ?? "").split("/").pop();
      return { external_id: String(r.uri ?? ""), url: rkey ? `https://bsky.app/profile/${s.handle ?? s.did}/post/${rkey}` : null };
    }
  }
}
