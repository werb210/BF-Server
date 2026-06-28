import type { MulterRequest } from "../../types/multer.js";
import type { Request, Response } from "express";
import fs from "fs";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { pool, runQuery } from "../../db.js";
import { embedAndStore } from "./knowledge.service.js";

const uploadDir = "/tmp/uploads";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 5,
  },
});

export { upload };

const knowledgeDocs: Array<{
  id: string;
  filename: string;
  uploadedAt: number;
}> = [];
const MAX_KNOWLEDGE_DOCS = 500;
const FILE_TEXT_PARSE_ERROR =
  "Could not read text from this file. Supported: PDF and plain-text files (scanned PDFs have no text layer).";

function pushBounded<T>(arr: T[], item: T, maxItems = MAX_KNOWLEDGE_DOCS): void {
  arr.push(item);
  if (arr.length > maxItems) {
    arr.shift();
  }
}

function cleanupFile(filePath: string): void {
  fs.unlink(filePath, () => undefined);
}

export const AIKnowledgeController = {
  async upload(req: MulterRequest, res: Response): Promise<void> {
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const sheetId = uuid();
    pushBounded(knowledgeDocs, {
      id: sheetId,
      filename: file.originalname,
      uploadedAt: Date.now(),
    });

    try {
      // BF_AI_KNOWLEDGE_PDF_EXTRACT_v1 - extract real text per file type (PDF via
      // pdf-parse, else utf8). The old path read PDFs as raw utf8 bytes, producing
      // binary garbage that 500'd the embed/insert. extractTextFromBuffer already
      // handles PDFs.
      const buffer = await fs.promises.readFile(file.path);
      const { extractTextFromBuffer } = await import("../../ai/embeddingService.js");
      let extractedText = "";
      try {
        const raw = await extractTextFromBuffer(buffer, file.mimetype || "");
        extractedText = (raw || "").slice(0, 200_000).trim();
      } catch {
        res.status(422).json({ error: FILE_TEXT_PARSE_ERROR });
        return;
      }
      if (!extractedText && file.mimetype === "application/pdf") {
        res.status(422).json({ error: FILE_TEXT_PARSE_ERROR });
        return;
      }
      if (extractedText.length > 0) {
        await embedAndStore(pool, extractedText, "sheet", sheetId, sheetId);
      }
    } finally {
      cleanupFile(file.path);
    }

    res["json"]({ success: true, sheetId });
  },

  list(_req: Request, res: Response): void {
    res["json"]({
      documents: knowledgeDocs.map((doc) => ({
        id: doc.id,
        filename: doc.filename,
        uploadedAt: doc.uploadedAt,
      })),
    });
  },
};
