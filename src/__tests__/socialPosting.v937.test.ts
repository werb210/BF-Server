// BF_SERVER_v937_SOCIAL_POSTING
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: (s: unknown, p?: unknown[]) => h.query(s, p) }, runQuery: (s: unknown, p?: unknown[]) => h.query(s, p) }));

import { authorizeUrl, publish, exchange, type Http, type Live } from "../social/networks.js";
import { open, seal } from "../social/crypto.js";
import { publishDue, publishPost } from "../social/service.js";
import socialRouter from "../routes/social.js";

process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = "test-social-key-0123456789-abcdefghij";
const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });
const fakeHttp = (routes: Array<[RegExp, (url: string, init?: RequestInit) => Response]>) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const http: Http = async (url, init) => { calls.push({ url, init }); const r = routes.find(([re]) => re.test(url)); return r ? r[1](url, init) : new Response("{}", { status: 404 }); };
  return { http, calls };
};
const live = (network: Live["network"], extra: Partial<Live> = {}): Live => ({ network, external_id: "acct-1", access_token: "tok", refresh_token: null, expires_at: null, meta: {}, ...extra });

describe("tokens", () => {
  it("are sealed and opened, never stored as written", () => {
    const s = seal("secret-token")!;
    expect(s).not.toContain("secret-token");
    expect(open(s)).toBe("secret-token");
  });
});

describe("publishing to each network", () => {
  it("Facebook posts text with its link, or a photo with a caption", async () => {
    const { http, calls } = fakeHttp([[/\/feed$/, () => ok({ id: "p_1" })], [/\/photos$/, () => ok({ post_id: "p_2" })]]);
    expect(await publish(live("facebook"), { text: "Hello", link: "https://boreal.financial", image: null }, http)).toEqual({ external_id: "p_1", url: "https://www.facebook.com/p_1" });
    expect(String(calls[0].init?.body)).toContain("link=https%3A%2F%2Fboreal.financial");
    await publish(live("facebook"), { text: "Pic", link: null, image: "https://img.test/a.png" }, http);
    expect(calls[1].url).toMatch(/\/photos$/);
  });
  it("Instagram needs a picture and publishes in two steps", async () => {
    const { http, calls } = fakeHttp([[/\/media$/, () => ok({ id: "c1" })], [/\/media_publish$/, () => ok({ id: "m1" })]]);
    await expect(publish(live("instagram"), { text: "x", link: null, image: null }, http)).rejects.toThrow(/needs a picture/);
    expect((await publish(live("instagram"), { text: "x", link: null, image: "https://img.test/a.png" }, http)).external_id).toBe("m1");
    expect(String(calls[1].init?.body)).toContain("creation_id=c1");
  });
  it("X adds the link to the text and keeps it to 280 characters", async () => {
    const { http, calls } = fakeHttp([[/\/2\/tweets$/, () => ok({ data: { id: "99" } })]]);
    const r = await publish(live("x"), { text: "a".repeat(300), link: "https://b.test", image: null }, http);
    expect(r.url).toBe("https://x.com/i/web/status/99");
    expect(JSON.parse(String(calls[0].init?.body)).text.length).toBe(280);
  });
  it("LinkedIn posts as the profile or page with the link as an article", async () => {
    const { http, calls } = fakeHttp([[/rest\/posts$/, () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7" } })]]);
    const r = await publish(live("linkedin", { external_id: "urn:li:person:abc" }), { text: "Rates update", link: "https://boreal.financial/x", image: null }, http);
    expect(r.external_id).toBe("urn:li:share:7");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ author: "urn:li:person:abc", content: { article: { source: "https://boreal.financial/x" } } });
  });
  it("Bluesky makes the link clickable", async () => {
    const { http, calls } = fakeHttp([[/createSession$/, () => ok({ accessJwt: "j", did: "did:plc:1", handle: "boreal.bsky.social" })], [/createRecord$/, () => ok({ uri: "at://did:plc:1/app.bsky.feed.post/3k" })]]);
    const r = await publish(live("bluesky", { meta: { handle: "boreal.bsky.social" } }), { text: "New post", link: "https://b.test", image: null }, http);
    expect(r.url).toBe("https://bsky.app/profile/boreal.bsky.social/post/3k");
    expect(JSON.parse(String(calls[1].init?.body)).record.facets[0].features[0].uri).toBe("https://b.test");
  });
});

describe("pictures", () => {
  it("X uploads the picture and attaches it", async () => {
    const { http, calls } = fakeHttp([
      [/img\.test/, () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } })],
      [/media\/upload$/, () => ok({ data: { id: "m9" } })],
      [/\/2\/tweets$/, () => ok({ data: { id: "7" } })],
    ]);
    await publish(live("x"), { text: "Pic", link: null, image: "https://img.test/a.png" }, http);
    expect(JSON.parse(String(calls[2].init?.body)).media).toEqual({ media_ids: ["m9"] });
  });
  it("Bluesky attaches the picture as an image embed", async () => {
    const { http, calls } = fakeHttp([
      [/img\.test/, () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "image/jpeg" } })],
      [/createSession$/, () => ok({ accessJwt: "j", did: "did:plc:1", handle: "b.bsky.social" })],
      [/uploadBlob$/, () => ok({ blob: { ref: "bafy" } })],
      [/createRecord$/, () => ok({ uri: "at://did:plc:1/app.bsky.feed.post/3k" })],
    ]);
    await publish(live("bluesky", { meta: { handle: "b.bsky.social" } }), { text: "Pic", link: null, image: "https://img.test/a.jpg" }, http);
    expect(JSON.parse(String(calls[3].init?.body)).record.embed.images[0].image).toEqual({ ref: "bafy" });
  });
});

describe("connecting", () => {
  it("X sign-in uses PKCE", () => {
    process.env.X_CLIENT_ID = "xid"; process.env.X_CLIENT_SECRET = "xs";
    const u = new URL(authorizeUrl("x", "https://s.test/cb", "st", "chal"));
    expect(u.searchParams.get("code_challenge")).toBe("chal");
    expect(u.searchParams.get("scope")).toContain("tweet.write");
  });
  it("one Meta sign-in adds each Facebook Page and its Instagram account", async () => {
    process.env.META_APP_ID = "m"; process.env.META_APP_SECRET = "ms";
    const { http } = fakeHttp([
      [/oauth\/access_token\?.*fb_exchange_token/, () => ok({ access_token: "long" })],
      [/oauth\/access_token\?/, () => ok({ access_token: "short" })],
      [/me\/accounts/, () => ok({ data: [{ id: "pg1", name: "Boreal Financial", access_token: "pt", instagram_business_account: { id: "ig1", username: "borealfinancial" } }] })],
    ]);
    const out = await exchange("meta", "code", "https://s.test/cb", undefined, http);
    expect(out.map((a) => [a.network, a.external_id, a.name])).toEqual([["facebook", "pg1", "Boreal Financial"], ["instagram", "ig1", "@borealfinancial"]]);
  });
});

describe("one post to several accounts", () => {
  it("publishes to each, and one failure does not stop the others", async () => {
    const accounts = [
      { id: "a1", network: "x", name: "@boreal", external_id: "1", access_token_enc: seal("t1"), refresh_token_enc: null, expires_at: null, meta: {} },
      { id: "a2", network: "instagram", name: "@boreal", external_id: "2", access_token_enc: seal("t2"), refresh_token_enc: null, expires_at: null, meta: {} },
    ];
    h.query.mockReset();
    h.query.mockImplementation(answerBySql([
      [/FROM social_posts WHERE id::text = \$1/, { rows: [{ id: "p1", silo: "BF", body: "Hi", link_url: null, image_url: null, account_ids: ["a1", "a2"] }] }],
      [/FROM social_accounts WHERE silo = \$1 AND id::text = ANY/, { rows: accounts }],
      [/UPDATE social_posts SET status = \$2/, (_s: string, p?: unknown[]) => ({ rows: [{ id: "p1", status: p?.[1], results: JSON.parse(String(p?.[2])) }] })],
    ]));
    const { http } = fakeHttp([[/\/2\/tweets$/, () => ok({ data: { id: "5" } })]]);
    const post = await publishPost(h as any, "p1", http);
    expect(post.status).toBe("partial");
    expect(post.results.a1).toMatchObject({ ok: true, url: "https://x.com/i/web/status/5" });
    expect(post.results.a2).toMatchObject({ ok: false, error: expect.stringMatching(/needs a picture/) });
  });
});

describe("scheduled posts", () => {
  it("are claimed one at a time; one that fails is marked failed and the next still goes", async () => {
    let claims = 0;
    h.query.mockReset();
    h.query.mockImplementation(answerBySql([
      [/SET status = 'scheduled' WHERE status = 'publishing'/, { rows: [] }],
      [/SET status = 'publishing' WHERE id = \(/, () => ({ rows: claims++ < 2 ? [{ id: `p${claims}` }] : [] })],
      [/FROM social_posts WHERE id::text = \$1/, (_s: string, p?: unknown[]) => { if (p?.[0] === "p1") throw new Error("db hiccup"); return { rows: [{ id: "p2", silo: "BF", body: "Hi", link_url: null, image_url: null, account_ids: [] }] }; }],
      [/FROM social_accounts WHERE silo/, { rows: [] }],
      [/UPDATE social_posts SET status = \$2/, { rows: [{ id: "p2", status: "published" }] }],
      [/UPDATE social_posts SET status = 'failed'/, { rows: [] }],
    ]));
    expect(await publishDue(h as any, fakeHttp([]).http)).toBe(2);
    expect(callsMatching(h.query, /UPDATE social_posts SET status = 'failed'/)[0]![1]![0]).toBe("p1");
    expect(callsMatching(h.query, /UPDATE social_posts SET status = \$2/)).toHaveLength(1);
  });
});

describe("/api/social", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/social", socialRouter);
  const as = (role: string) => "Bearer " + jwt.sign({ sub: "76767676-7676-4676-8676-767676767676", role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
  beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([[/FROM social_accounts WHERE silo/, { rows: [] }]])); });

  it("lists networks with whether each is set up", async () => {
    const r = await request(app).get("/api/social/accounts").set("Authorization", as("Admin"));
    expect(r.status).toBe(200);
    expect(r.body.networks.find((n: any) => n.key === "bluesky").configured).toBe(true);
  });
  it("Staff cannot post", async () => {
    const r = await request(app).post("/api/social/posts").set("Authorization", as("Staff")).send({ body: "x", account_ids: [] });
    expect([403]).toContain(r.status);
    expect(callsMatching(h.query, /INSERT INTO social_posts/)).toHaveLength(0);
  });
  it("a post needs at least one of this silo's accounts", async () => {
    const r = await request(app).post("/api/social/posts").set("Authorization", as("Admin")).send({ body: "Hello", account_ids: ["11111111-1111-4111-8111-111111111111"] });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/at least one connected account/);
  });
  it("the sign-in comes back only with a valid state", async () => {
    const r = await request(app).get("/api/social/callback/linkedin?code=c&state=forged");
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/social=error/);
  });
});
