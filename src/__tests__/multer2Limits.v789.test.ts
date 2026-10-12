// BF_SERVER_v789_MULTER2 - multer upgraded 1.4.5-lts -> 2.x. The configuration
// shape used across the routes (memoryStorage + limits.fileSize / limits.files,
// upload.single / upload.array) must behave as before: a file under the limit
// arrives on req.file.buffer, one over it is rejected with LIMIT_FILE_SIZE, and
// a second file over `files: 1` is rejected with LIMIT_FILE_COUNT.
import { describe, expect, it } from "vitest";
import express from "express";
import multer from "multer";
import request from "supertest";
import { readFileSync } from "node:fs";

function app(limits: multer.Options["limits"], mode: "single" | "array" = "single") {
  const upload = multer({ storage: multer.memoryStorage(), limits });
  const a = express();
  const mw = mode === "single" ? upload.single("file") : upload.array("files", 20);
  a.post("/u", mw, (req, res) => {
    const files = mode === "single" ? (req.file ? [req.file] : []) : ((req.files as Express.Multer.File[]) ?? []);
    res.json({ n: files.length, sizes: files.map((f) => f.buffer.length), names: files.map((f) => f.originalname), body: req.body });
  });
  a.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err instanceof multer.MulterError ? 413 : 500).json({ code: err?.code ?? null });
  });
  return a;
}

describe("multer 2.x with the repo's configuration", () => {
  it("is on 2.x", () => {
    const pkg = JSON.parse(readFileSync("node_modules/multer/package.json", "utf8"));
    expect(Number(String(pkg.version).split(".")[0])).toBeGreaterThanOrEqual(2);
  });

  it("accepts a file under limits.fileSize into memory, with text fields", async () => {
    const res = await request(app({ fileSize: 1024 }))
      .post("/u")
      .field("category", "bank_statements")
      .attach("file", Buffer.alloc(512, 1), "a.pdf");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ n: 1, sizes: [512], names: ["a.pdf"], body: { category: "bank_statements" } });
  });

  it("rejects a file over limits.fileSize with LIMIT_FILE_SIZE", async () => {
    const res = await request(app({ fileSize: 1024 })).post("/u").attach("file", Buffer.alloc(2048, 1), "big.pdf");
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("LIMIT_FILE_SIZE");
  });

  it("enforces limits.files", async () => {
    const res = await request(app({ fileSize: 1024, files: 1 }, "array"))
      .post("/u")
      .attach("files", Buffer.alloc(10, 1), "a.pdf")
      .attach("files", Buffer.alloc(10, 1), "b.pdf");
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("LIMIT_FILE_COUNT");
  });

  it("upload.array takes several files under the limits", async () => {
    const res = await request(app({ fileSize: 1024 }, "array"))
      .post("/u")
      .attach("files", Buffer.alloc(10, 1), "a.pdf")
      .attach("files", Buffer.alloc(20, 1), "b.pdf");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ n: 2, sizes: [10, 20] });
  });
});
