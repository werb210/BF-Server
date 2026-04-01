"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const zod_1 = require("zod");
const auth_js_1 = require("../middleware/auth.js");
const hash_1 = require("../lib/hash");
const response_1 = require("../middleware/response");
const toStringSafe_1 = require("../utils/toStringSafe");
const db_1 = require("../lib/db");
const validate_1 = require("../middleware/validate");
const router = express_1.default.Router();
const inMemoryDb = {};
const documentUploadSchema = zod_1.z.object({
    applicationId: zod_1.z.string().optional().nullable(),
    category: zod_1.z.string().optional().nullable(),
    filename: zod_1.z.string().optional().nullable(),
    file: zod_1.z.unknown().optional(),
}).passthrough();
router.post("/upload", auth_js_1.requireAuth, (0, validate_1.validate)(documentUploadSchema), async (req, res) => {
    if (!req.body?.applicationId || !req.body?.category || (!req.body?.file && !(req.file))) {
        return (0, response_1.fail)(res, 400, "INVALID_DOCUMENT_UPLOAD_PAYLOAD");
    }
    const id = Date.now().toString();
    const bodyString = JSON.stringify(req.body ?? {});
    const hash = (0, hash_1.sha256)(Buffer.from(bodyString));
    const doc = {
        id,
        status: "uploaded",
        metadata: req.body,
        hash
    };
    inMemoryDb[id] = doc;
    try {
        await (0, db_1.queryDb)("INSERT INTO documents (application_id, filename, hash) VALUES ($1,$2,$3)", [req.body?.applicationId ?? null, req.body?.filename ?? `upload-${id}.json`, hash]);
    }
    catch (error) {
        console.error("document hash insert failed", error);
    }
    return (0, response_1.ok)(res, { ...doc, hash });
});
router.patch("/:id/accept", auth_js_1.requireAuth, (req, res) => {
    const doc = inMemoryDb[(0, toStringSafe_1.toStringSafe)(req.params.id)];
    if (!doc)
        return (0, response_1.fail)(res, 404, "not_found");
    doc.status = "accepted";
    return (0, response_1.ok)(res, doc);
});
router.patch("/:id/reject", auth_js_1.requireAuth, (req, res) => {
    const doc = inMemoryDb[(0, toStringSafe_1.toStringSafe)(req.params.id)];
    if (!doc)
        return (0, response_1.fail)(res, 404, "not_found");
    doc.status = "rejected";
    return (0, response_1.ok)(res, doc);
});
exports.default = router;
