import { Router } from "express";
import { db } from "../db";
import { products as fallbackProducts } from "../data/products";
import { generateEmbedding } from "../ai/embeddingService";
import { logError } from "../observability/logger";

const router = Router();

router.get("/", async (_req: any, res: any) => {
  try {
    const result = await db.query(
      `select id, lender_id, name, category, status, terms_summary, created_at
       from lender_products
       order by created_at desc nulls last`
    );

    if (result.rows.length === 0) {
      res.status(200).json({ success: true, data: { products: fallbackProducts } });
      return;
    }

    res.status(200).json({ success: true, data: { products: result.rows } });
  } catch (error) {
    logError("products_list_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: "Server error" });
  }
});

router.get("/knowledge", async (_req: any, res: any) => {
  try {
    const docs = await db.query(
      `select id, source_type, source_id, content, created_at
       from ai_knowledge
       order by created_at desc
       limit 200`
    );

    const withEmbeddings = await Promise.all(
      docs.rows.map(async (row) => ({
        ...row,
        embedding: await generateEmbedding(String(row.content ?? "")),
      }))
    );

    res.status(200).json({ success: true, data: { knowledge: withEmbeddings } });
  } catch (error) {
    logError("products_knowledge_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: "Server error" });
  }
});

export default router;
