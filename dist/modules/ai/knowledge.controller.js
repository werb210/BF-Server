"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIKnowledgeController = exports.upload = void 0;
const fs_1 = __importDefault(require("fs"));
const readline_1 = __importDefault(require("readline"));
const multer_1 = __importDefault(require("multer"));
const uuid_1 = require("uuid");
const db_1 = require("../../db");
const knowledge_service_1 = require("./knowledge.service");
const uploadDir = "/tmp/uploads";
if (!fs_1.default.existsSync(uploadDir)) {
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
}
const upload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: (_, __, cb) => cb(null, uploadDir),
        filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
    }),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 5,
    },
});
exports.upload = upload;
const knowledgeDocs = [];
const MAX_KNOWLEDGE_DOCS = 500;
function pushBounded(arr, item, maxItems = MAX_KNOWLEDGE_DOCS) {
    arr.push(item);
    if (arr.length > maxItems) {
        arr.shift();
    }
}
function cleanupFile(filePath) {
    fs_1.default.unlink(filePath, () => undefined);
}
async function readTextPreview(filePath, maxChars = 200000) {
    const stream = fs_1.default.createReadStream(filePath, { encoding: "utf8" });
    const lineReader = readline_1.default.createInterface({ input: stream, crlfDelay: Infinity });
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
exports.AIKnowledgeController = {
    async upload(req, res) {
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: "No file uploaded" });
            return;
        }
        const sheetId = (0, uuid_1.v4)();
        pushBounded(knowledgeDocs, {
            id: sheetId,
            filename: file.originalname,
            uploadedAt: Date.now(),
        });
        try {
            const extractedText = await readTextPreview(file.path);
            if (extractedText.length > 0) {
                await (0, knowledge_service_1.embedAndStore)(db_1.pool, extractedText, "sheet", sheetId);
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
