// BF_SERVER_LIBRARY_UPLOAD_v777
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const calls: Array<{ path: string; method: string; headers?: any; body?: any }> = [];
vi.mock("../middleware/auth.js", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u1", role: "Staff" }; next(); } }));
vi.mock("../db.js", () => ({ pool: { query: async (sql: string) => sql.includes("FROM staff_library") ? { rows: [{ drive_id: "D1", item_id: "ROOT", share_url: "https://share/lib" }] } : { rows: [] } } }));
vi.mock("../modules/o365/graphClient.js", () => ({
  getGraphForUser: async () => ({
    accessToken: "t",
    fetch: async (path: string, init?: any) => {
      calls.push({ path, method: init?.method ?? "GET", headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
      if (path.includes("/createUploadSession")) return new Response(JSON.stringify({ uploadUrl: "https://upload.example/session" }), { status: 200 });
      if (path.endsWith("/children")) return new Response(JSON.stringify({ id: "F9", name: "Lender Forms 2", folder: {}, webUrl: "https://od/F9" }), { status: 201 });
      return new Response("{}", { status: 200 });
    },
  }),
}));
import o365 from "../routes/o365.js";
import { cleanLibraryName } from "../routes/o365.js";

const app = express();
app.use(express.json({ limit: "40mb" }));
app.use("/api/o365", o365);

beforeEach(() => { calls.length = 0; vi.restoreAllMocks(); });

describe("Staff Library upload and folders", () => {
  it("uploads into the chosen folder through an upload session and returns a link", async () => {
    const put = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "X1", name: "Bizcap form.pdf", webUrl: "https://od/X1", size: 5 }), { status: 201 }));
    const r = await request(app).post("/api/o365/library/upload").send({ name: "Bizcap form.pdf", folderId: "F1", contentBase64: Buffer.from("hello").toString("base64") });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ id: "X1", name: "Bizcap form.pdf", webUrl: "https://od/X1", isFolder: false });
    expect(calls[0]!.headers.Prefer).toBe("redeemSharingLink");
    expect(calls[1]!.path).toBe("/drives/D1/items/F1:/Bizcap%20form.pdf:/createUploadSession");
    expect(put.mock.calls[0]![0]).toBe("https://upload.example/session");
    expect((put.mock.calls[0]![1] as any).headers["Content-Range"]).toBe("bytes 0-4/5");
  });
  it("refuses empty and oversized files with a clear message", async () => {
    expect((await request(app).post("/api/o365/library/upload").send({ name: "a.pdf", contentBase64: "" })).status).toBe(400);
    const big = Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64");
    const r = await request(app).post("/api/o365/library/upload").send({ name: "a.pdf", contentBase64: big });
    expect(r.status).toBe(413);
    expect(r.body.message).toContain("25 MB");
  });
  it("makes a folder at the top of the library by default", async () => {
    const r = await request(app).post("/api/o365/library/folder").send({ name: "Lender Forms" });
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.method === "POST")!.path).toBe("/drives/D1/items/ROOT/children");
    expect(r.body.item.isFolder).toBe(true);
  });
  it("cleans names OneDrive would refuse", () => {
    expect(cleanLibraryName('a/b:c*?"<>|.  ')).toBe("a b c");
  });
});
