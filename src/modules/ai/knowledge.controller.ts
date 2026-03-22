import type { MulterRequest } from "../../types/multer";
import type { Request, Response } from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { pool } from "../../db";
import { embedAndStore } from "./knowledge.service";

const storage = multer.memoryStorage();
export const upload = multer({ storage });

const knowledgeDocs: Array<{
  id: string;
  filename: string;
  buffer: Buffer;
  uploadedAt: number;
}> = [];

export const AIKnowledgeController = {
  async upload(req: MulterRequest, res: Response): Promise<void> {
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const sheetId = uuid();
    knowledgeDocs.push({
      id: sheetId,
      filename: file.originalname,
      buffer: file.buffer,
      uploadedAt: Date.now(),
    });

    const extractedText = file.buffer.toString("utf8").trim();
    if (extractedText.length > 0) {
      await embedAndStore(pool, extractedText, "sheet", sheetId);
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
