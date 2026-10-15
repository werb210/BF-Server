// BF_SERVER_v810_LIBRARY_PLUS - the Staff Library's Dropbox-style features, against a fake OneDrive and a database
// mock that answers by SQL content.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

type Node = { id: string; name: string; parent: string | null; folder?: boolean; size?: number; mime?: string };
const h = vi.hoisted(() => ({
  query: vi.fn(),
  nodes: new Map<string, any>(),
  graphCalls: [] as Array<{ path: string; method: string; body?: any }>,
  nextId: 1,
}));

vi.mock("../middleware/auth.js", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "11111111-1111-4111-8111-111111111111", first_name: "Todd", last_name: "W", role: "Staff" }; next(); } }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  return { ...real, pool: { query: q }, dbQuery: q, runQuery: q };
});

function nodePath(id: string): string {
  const n = h.nodes.get(id)!;
  return (n.parent ? nodePath(n.parent) : "/drive/root:") + "/" + n.name;
}
function json(n: any) {
  return {
    id: n.id, name: n.name, size: n.size ?? 0, webUrl: "https://od/" + n.id, lastModifiedDateTime: "2026-10-15T10:00:00Z",
    lastModifiedBy: { user: { displayName: "Andrew P" } },
    ...(n.folder ? { folder: { childCount: [...h.nodes.values()].filter((c) => c.parent === n.id).length } } : { file: { mimeType: n.mime ?? "application/pdf" }, "@microsoft.graph.downloadUrl": "https://dl.example/" + n.id }),
    parentReference: { id: n.parent, path: n.parent ? nodePath(n.parent) : "/drive/root:" },
  };
}
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

vi.mock("../modules/o365/graphClient.js", () => ({
  getGraphForUser: async () => ({
    accessToken: "t",
    fetch: async (path: string, init?: any) => {
      const method = init?.method ?? "GET";
      const body = init?.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
      h.graphCalls.push({ path, method, body });
      if (path.startsWith("/shares/") && path.includes("/driveItem/children")) return res({ value: [...h.nodes.values()].filter((c) => c.parent === "ROOT").map(json) });
      if (path.startsWith("/shares/")) return res({ id: "ROOT" });
      const m = path.match(/^\/drives\/D1\/items\/([^/?:]+)(.*)$/);
      if (!m) return res({}, 404);
      const id = decodeURIComponent(m[1]!);
      const rest = m[2]!;
      const node = h.nodes.get(id);
      if (!node) return res({ error: "itemNotFound" }, 404);
      if (rest.startsWith("/children") && method === "GET") return res({ value: [...h.nodes.values()].filter((c) => c.parent === id).map(json) });
      if (rest.startsWith("/children") && method === "POST") {
        const existing = [...h.nodes.values()].find((c) => c.parent === id && c.name === body.name);
        if (existing) return res({ error: "nameAlreadyExists" }, 409);
        const n = { id: "N" + h.nextId++, name: body.name, parent: id, folder: true };
        h.nodes.set(n.id, n);
        return res(json(n), 201);
      }
      if (rest.startsWith(":/") && rest.endsWith(":/createUploadSession")) return res({ uploadUrl: "https://upload.example/s/" + id + "/" + rest.slice(2, -20) });
      if (rest.startsWith(":/")) {
        const name = decodeURIComponent(rest.slice(2));
        const c = [...h.nodes.values()].find((x) => x.parent === id && x.name === name);
        return c ? res(json(c)) : res({}, 404);
      }
      if (rest.startsWith("/search(")) return res({ value: [...h.nodes.values()].filter((c) => c.id !== "ROOT").map(json) });
      if (rest === "/preview") return res({ getUrl: "https://preview.example/" + id });
      if (rest === "/versions") return res({ value: [{ id: "2.0", lastModifiedDateTime: "2026-10-15T10:00:00Z", size: 9, lastModifiedBy: { user: { displayName: "Andrew P" } } }, { id: "1.0", size: 5 }] });
      if (rest.endsWith("/restoreVersion")) return new Response(null, { status: 204 });
      if (method === "PATCH") {
        if (body.parentReference?.id) node.parent = body.parentReference.id;
        if (body.name) node.name = body.name;
        return res(json(node));
      }
      if (method === "DELETE") { h.nodes.delete(id); return new Response(null, { status: 204 }); }
      return res(json(node));
    },
  }),
}));

import o365 from "../routes/o365.js";
import shared from "../routes/libraryPublic.js";
import { hashPassword, passwordMatches, hashToken } from "../modules/library/library.repo.js";

const app = express();
app.use(express.json());
app.use("/api/o365", o365);
app.use("/api/shared", shared);

const db = { trash: new Map<string, any>(), shares: new Map<string, any>(), requests: new Map<string, any>(), lib: {} as any };
function reset() {
  h.nodes.clear();
  h.graphCalls.length = 0;
  h.nextId = 1;
  const add = (n: Node) => h.nodes.set(n.id, n);
  add({ id: "ROOT", name: "Boreal Staff Library", parent: null, folder: true });
  add({ id: "LF", name: "Lender Forms", parent: "ROOT", folder: true });
  add({ id: "F1", name: "Bizcap form.pdf", parent: "LF", size: 10 });
  add({ id: "BIG", name: "Deck.pdf", parent: "ROOT", size: 4 * 1024 * 1024 });
  add({ id: "OUT", name: "Private.pdf", parent: null, size: 3 }); // in the owner's OneDrive, not in the library
  db.trash.clear(); db.shares.clear(); db.requests.clear();
  db.lib = { drive_id: "D1", item_id: "ROOT", share_url: "https://share/lib", created_by: "11111111-1111-4111-8111-111111111111", trash_item_id: null };
}

beforeEach(() => {
  reset();
  h.query.mockReset().mockImplementation(answerBySql([
    [/FROM staff_library/, () => ({ rows: [db.lib] })],
    [/UPDATE staff_library SET trash_item_id/, (_s: string, p?: unknown[]) => { db.lib.trash_item_id = p![0]; return { rows: [] }; }],
    [/INSERT INTO library_trash/, (_s: string, p?: unknown[]) => { db.trash.set(String(p![0]), { item_id: p![0], item_name: p![1], is_folder: p![2], original_parent_id: p![3] }); return { rows: [] }; }],
    [/SELECT \* FROM library_trash WHERE item_id/, (_s: string, p?: unknown[]) => ({ rows: db.trash.has(String(p![0])) ? [db.trash.get(String(p![0]))] : [] })],
    [/DELETE FROM library_trash/, (_s: string, p?: unknown[]) => { db.trash.delete(String(p![0])); return { rows: [] }; }],
    [/FROM library_trash WHERE deleted_at </, { rows: [] }],
    [/FROM library_trash ORDER BY/, () => ({ rows: [...db.trash.values()] })],
    [/INSERT INTO library_share_links/, (_s: string, p?: unknown[]) => { db.shares.set(String(p![0]), { id: "S1", token_hash: p![0], item_id: p![1], item_name: p![2], allow_download: p![3], password_hash: p![4], expires_at: new Date(Date.now() + Number(p![5]) * 864e5).toISOString(), created_by: p![6], created_by_name: p![7], revoked_at: null }); return { rows: [{ id: "S1", expires_at: "2026-10-22" }] }; }],
    [/FROM library_share_links WHERE token_hash/, (_s: string, p?: unknown[]) => ({ rows: db.shares.has(String(p![0])) ? [db.shares.get(String(p![0]))] : [] })],
    [/INSERT INTO library_file_requests/, (_s: string, p?: unknown[]) => { db.requests.set(String(p![0]), { id: "R1", token_hash: p![0], folder_id: p![1], folder_name: p![2], title: p![3], expires_at: new Date(Date.now() + 864e5).toISOString(), created_by: p![5], created_by_name: p![6] }); return { rows: [{ id: "R1", expires_at: "2026-10-29" }] }; }],
    [/FROM library_file_requests WHERE token_hash/, (_s: string, p?: unknown[]) => ({ rows: db.requests.has(String(p![0])) ? [db.requests.get(String(p![0]))] : [] })],
    [/FROM library_stars/, { rows: [{ item_id: "F1", item_name: "Bizcap form.pdf", is_folder: false }] }],
  ]));
});

const tokenFrom = (url: string) => url.split("/").pop() as string;

describe("v810 recycle bin", () => {
  it("delete moves the file into the library's recycle bin and records where it was", async () => {
    const r = await request(app).delete("/api/o365/library/item/F1");
    expect(r.status).toBe(200);
    expect(r.body.restoreDays).toBe(30);
    const bin = [...h.nodes.values()].find((n) => n.name === "Recycle Bin (Boreal)")!;
    expect(h.nodes.get("F1")!.parent).toBe(bin.id);
    expect(db.trash.get("F1")).toMatchObject({ item_name: "Bizcap form.pdf", original_parent_id: "LF" });
    expect(callsMatching(h.query, /INSERT INTO library_activity/).some((c) => (c[1] as unknown[])[3] === "deleted")).toBe(true);
  });

  it("restore puts it back in its folder", async () => {
    await request(app).delete("/api/o365/library/item/F1");
    const r = await request(app).post("/api/o365/library/trash/F1/restore");
    expect(r.status).toBe(200);
    expect(h.nodes.get("F1")!.parent).toBe("LF");
    expect(db.trash.has("F1")).toBe(false);
  });

  it("the recycle bin folder is hidden from the library list", async () => {
    await request(app).delete("/api/o365/library/item/F1");
    const r = await request(app).get("/api/o365/library");
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => i.name)).toEqual(["Lender Forms", "Deck.pdf"]);
    expect(r.body.items[1]).toMatchObject({ size: 4 * 1024 * 1024, modifiedBy: "Andrew P", mimeType: "application/pdf" });
  });
});

describe("v810 only the Staff Library can be touched", () => {
  it("refuses a OneDrive file outside the library", async () => {
    for (const call of [request(app).delete("/api/o365/library/item/OUT"), request(app).post("/api/o365/library/item/OUT/share").send({}), request(app).get("/api/o365/library/item/OUT/content")]) {
      expect((await call).status).toBe(404);
    }
    expect(h.nodes.get("OUT")!.parent).toBeNull();
  });
  it("refuses the library folder itself", async () => {
    expect((await request(app).delete("/api/o365/library/item/ROOT")).status).toBe(400);
  });
});

describe("v810 rename, move, search, versions, stars", () => {
  it("renames and moves", async () => {
    expect((await request(app).patch("/api/o365/library/item/F1").send({ name: "Bizcap 2026.pdf" })).body.item.name).toBe("Bizcap 2026.pdf");
    const m = await request(app).post("/api/o365/library/item/F1/move").send({ folderId: "" });
    expect(m.status).toBe(200);
    expect(h.nodes.get("F1")!.parent).toBe("ROOT");
    expect((await request(app).post("/api/o365/library/item/LF/move").send({ folderId: "F1" })).status).toBe(400);
  });
  it("search leaves out the recycle bin and anything outside the library", async () => {
    await request(app).delete("/api/o365/library/item/BIG");
    const r = await request(app).get("/api/o365/library/search").query({ q: "form" });
    expect(r.status).toBe(200);
    const names = r.body.items.map((i: any) => i.name);
    expect(names).toContain("Bizcap form.pdf");
    expect(names).not.toContain("Deck.pdf");
    expect(names).not.toContain("Recycle Bin (Boreal)");
  });
  it("lists and restores versions", async () => {
    const v = await request(app).get("/api/o365/library/item/F1/versions");
    expect(v.body.versions[0]).toMatchObject({ id: "2.0", modifiedBy: "Andrew P" });
    expect((await request(app).post("/api/o365/library/item/F1/versions/1.0/restore")).status).toBe(200);
    expect(h.graphCalls.some((c) => c.path.endsWith("/versions/1.0/restoreVersion"))).toBe(true);
  });
  it("stars are per person", async () => {
    await request(app).put("/api/o365/library/item/F1/star").send({ starred: true, name: "Bizcap form.pdf" });
    expect((callsMatching(h.query, /INSERT INTO library_stars/)[0]![1] as unknown[])[0]).toBe("11111111-1111-4111-8111-111111111111");
    expect((await request(app).get("/api/o365/library/stars")).body.items[0].item_id).toBe("F1");
  });
});

describe("v810 send to client", () => {
  it("returns a small file's content, and refuses one over 3 MB", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("hello"));
    const ok = await request(app).get("/api/o365/library/item/F1/content");
    expect(ok.body.dataUrl).toBe("data:application/pdf;base64," + Buffer.from("hello").toString("base64"));
    expect((await request(app).get("/api/o365/library/item/BIG/content")).status).toBe(413);
    f.mockRestore();
  });
});

describe("v810 share links for people outside Boreal", () => {
  it("a password link shows the file name, refuses a wrong password and sends the file for the right one", async () => {
    const r = await request(app).post("/api/o365/library/item/F1/share").send({ expiresDays: 7, password: "boreal1", allowDownload: true });
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\/server\.boreal\.financial\/api\/shared\/f\/[A-Za-z0-9_-]{30,}$/);
    const t = tokenFrom(r.body.url);
    expect(db.shares.get(hashToken(t)).password_hash).toMatch(/^scrypt\$/);
    const pageRes = await request(app).get("/api/shared/f/" + t);
    expect(pageRes.status).toBe(200);
    expect(pageRes.text).toContain("Bizcap form.pdf");
    expect(pageRes.text).toContain('type="password"');
    expect((await request(app).post("/api/shared/f/" + t + "/file").type("form").send({ password: "nope", mode: "download" })).status).toBe(401);
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("PDFDATA"));
    const got = await request(app).post("/api/shared/f/" + t + "/file").type("form").send({ password: "boreal1", mode: "download" });
    expect(got.status).toBe(200);
    expect(got.headers["content-disposition"]).toContain("attachment");
    expect(f.mock.calls[0]![0]).toBe("https://dl.example/F1");
    f.mockRestore();
  });
  it("an expired, revoked or made-up link has ended", async () => {
    const r = await request(app).post("/api/o365/library/item/F1/share").send({ expiresDays: 7 });
    const t = tokenFrom(r.body.url);
    db.shares.get(hashToken(t)).expires_at = "2020-01-01T00:00:00Z";
    expect((await request(app).get("/api/shared/f/" + t)).status).toBe(410);
    expect((await request(app).get("/api/shared/f/notarealtokenatallxxxxxx")).status).toBe(410);
  });
  it("folders are not shared as links", async () => {
    expect((await request(app).post("/api/o365/library/item/LF/share").send({})).status).toBe(400);
  });
});

describe("v810 file requests", () => {
  it("someone outside Boreal uploads into the chosen folder and the requester is notified", async () => {
    const r = await request(app).post("/api/o365/library/requests").send({ folderId: "LF", title: "Signed lender agreement", expiresDays: 14 });
    expect(r.status).toBe(200);
    const t = tokenFrom(r.body.url);
    expect((await request(app).get("/api/shared/r/" + t)).text).toContain("Signed lender agreement");
    const put = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "UP1", name: "agreement.pdf" }), { status: 201 }));
    const up = await request(app).post("/api/shared/r/" + t + "/upload")
      .set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent("agreement.pdf")).set("X-Uploader", "Jane%20Lender")
      .send(Buffer.from("signed"));
    expect(up.status).toBe(200);
    expect(String(put.mock.calls[0]![0])).toContain("https://upload.example/s/LF/");
    const note = callsMatching(h.query, /INSERT INTO notifications/)[0]![1] as unknown[];
    expect(note[0]).toBe("11111111-1111-4111-8111-111111111111");
    expect(String(note[2])).toContain("Jane Lender uploaded agreement.pdf");
    put.mockRestore();
  });
});

describe("v810 passwords", () => {
  it("are stored hashed and checked in constant time", () => {
    const stored = hashPassword("boreal1");
    expect(stored).not.toContain("boreal1");
    expect(passwordMatches("boreal1", stored)).toBe(true);
    expect(passwordMatches("boreal2", stored)).toBe(false);
    expect(passwordMatches("anything", null)).toBe(true);
  });
});

describe("v810 zip", () => {
  it("downloads a folder as a zip", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("filedata"));
    const r = await request(app).get("/api/o365/library/zip").query({ item: "LF" }).buffer(true).parse((resp, cb) => { const chunks: Buffer[] = []; resp.on("data", (c: Buffer) => chunks.push(c)); resp.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/zip");
    expect((r.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    expect((r.body as Buffer).includes(Buffer.from("Bizcap form.pdf"))).toBe(true);
    f.mockRestore();
  });
});
