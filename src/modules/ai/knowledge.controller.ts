import type { MulterRequest } from "../../types/multer";
import type { Request, Response } from "express";
import fs from "fs";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { pool } from "../../db";
import { embedAndStore } from "./knowledge.service";

const upload = multer({
  storage: multer.diskStorage({
    destination: "/tmp",
    filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

export { upload };

const knowledgeDocs: Array<{
  id: string;
  filename: string;
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
      uploadedAt: Date.now(),
    });

    if (knowledgeDocs.length > 1000) {
      knowledgeDocs.shift();
    }

    const extractedText = fs.readFileSync(file.path, "utf8").trim();
    if (extractedText.length > 0) {
      await embedAndStore(pool, extractedText, "sheet", sheetId);
    }

    fs.unlink(file.path, () => undefined);

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
