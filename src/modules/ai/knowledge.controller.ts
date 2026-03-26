import type { MulterRequest } from "../../types/multer";
import type { Request, Response } from "express";
import fs from "fs";
import readline from "readline";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { pool } from "../../db";
import { embedAndStore } from "./knowledge.service";

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

function pushBounded<T>(arr: T[], item: T, maxItems = MAX_KNOWLEDGE_DOCS): void {
  arr.push(item);
  if (arr.length > maxItems) {
    arr.shift();
  }
}

function cleanupFile(filePath: string): void {
  fs.unlink(filePath, () => undefined);
}

async function readTextPreview(filePath: string, maxChars = 200_000): Promise<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let combined = "";

  for await (const line of lineReader) {
    if (combined.length >= maxChars) {
      break;
    }
    combined += `${line}\n`;
  }

  lineReader.close();
  stream.close();
  return combined.trim();
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
      const extractedText = await readTextPreview(file.path);
      if (extractedText.length > 0) {
        await embedAndStore(pool, extractedText, "sheet", sheetId);
      }
    } finally {
      cleanupFile(file.path);
    }

    res.json({ success: true, sheetId });
  },

  list(_req: Request, res: Response): void {
    res.json({
      documents: knowledgeDocs.map((doc) => ({
        id: doc.id,
        filename: doc.filename,
        uploadedAt: doc.uploadedAt,
      })),
    });
  },
};
