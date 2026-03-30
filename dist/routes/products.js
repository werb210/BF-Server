"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const products_1 = require("../data/products");
const embeddingService_1 = require("../ai/embeddingService");
const logger_1 = require("../observability/logger");
const router = (0, express_1.Router)();
router.get("/", async (_req, res) => {
    try {
        const result = await db_1.db.query(`select id, lender_id, name, category, status, terms_summary, created_at
       from lender_products
       order by created_at desc nulls last`);
        if (result.rows.length === 0) {
            res.status(200).json({ success: true, data: { products: products_1.products } });
            return;
        }
        res.status(200).json({ success: true, data: { products: result.rows } });
    }
    catch (error) {
        (0, logger_1.logError)("products_list_failed", {
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: "Server error" });
    }
});
router.get("/knowledge", async (_req, res) => {
    try {
        const docs = await db_1.db.query(`select id, source_type, source_id, content, created_at
       from ai_knowledge
       order by created_at desc
       limit 200`);
        const withEmbeddings = await Promise.all(docs.rows.map(async (row) => ({
            ...row,
            embedding: await (0, embeddingService_1.generateEmbedding)(String(row.content ?? "")),
        })));
        res.status(200).json({ success: true, data: { knowledge: withEmbeddings } });
    }
    catch (error) {
        (0, logger_1.logError)("products_knowledge_failed", {
            message: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: "Server error" });
    }
});
exports.default = router;
