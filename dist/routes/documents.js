import express from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { sha256 } from "../lib/hash.js";
import { ok, fail } from "../middleware/response.js";
import { toStringSafe } from "../utils/toStringSafe.js";
import { runQuery } from "../lib/db.js";
import { validate } from "../middleware/validate.js";
const router = express.Router();
const inMemoryDb = {};
const documentUploadSchema = z.object({
    applicationId: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    filename: z.string().optional().nullable(),
    file: z.unknown().optional(),
}).passthrough();
router.post("/upload", requireAuth, validate(documentUploadSchema), async (req, res) => {
    if (!req.body?.applicationId || !req.body?.category || (!req.body?.file && !(req.file))) {
        return fail(res, 400, "INVALID_DOCUMENT_UPLOAD_PAYLOAD");
    }
    const id = Date.now().toString();
    const bodyString = JSON.stringify(req.body ?? {});
    const hash = sha256(Buffer.from(bodyString));
    const doc = {
        id,
        status: "uploaded",
        metadata: req.body,
        hash
    };
    inMemoryDb[id] = doc;
    try {
        await runQuery("INSERT INTO documents (application_id, filename, hash) VALUES ($1,$2,$3)", [req.body?.applicationId ?? null, req.body?.filename ?? `upload-${id}.json`, hash]);
    }
    catch (error) {
        console.error("document hash insert failed", error);
    }
    return ok(res, { ...doc, hash });
});
router.patch("/:id/accept", requireAuth, (req, res) => {
    const doc = inMemoryDb[toStringSafe(req.params.id)];
    if (!doc)
        return fail(res, 404, "not_found");
    doc.status = "accepted";
    return ok(res, doc);
});
router.patch("/:id/reject", requireAuth, (req, res) => {
    const doc = inMemoryDb[toStringSafe(req.params.id)];
    if (!doc)
        return fail(res, 404, "not_found");
    doc.status = "rejected";
    return ok(res, doc);
});
export default router;
