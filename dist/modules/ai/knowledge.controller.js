import fs from "fs";
import readline from "readline";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { pool } from "../../db.js";
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
const knowledgeDocs = [];
const MAX_KNOWLEDGE_DOCS = 500;
function pushBounded(arr, item, maxItems = MAX_KNOWLEDGE_DOCS) {
    arr.push(item);
    if (arr.length > maxItems) {
        arr.shift();
    }
}
function cleanupFile(filePath) {
    fs.unlink(filePath, () => undefined);
}
async function readTextPreview(filePath, maxChars = 200_000) {
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
    async upload(req, res) {
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
        }
        finally {
            cleanupFile(file.path);
        }
        res["json"]({ success: true, sheetId });
    },
    list(_req, res) {
        res["json"]({
            documents: knowledgeDocs.map((doc) => ({
                id: doc.id,
                filename: doc.filename,
                uploadedAt: doc.uploadedAt,
            })),
        });
    },
};
