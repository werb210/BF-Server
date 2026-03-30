"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestAllProducts = ingestAllProducts;
exports.ingestProductById = ingestProductById;
const knowledge_service_1 = require("./knowledge.service");
function toProductKnowledge(row) {
    return [
        `Product: ${row.name ?? "Unnamed Product"}`,
        `Type: ${row.category ?? "N/A"}`,
        `Min Rate: ${row.interest_min ?? "N/A"}`,
        `Max Rate: ${row.interest_max ?? "N/A"}`,
        `Term Min: ${row.term_min ?? "N/A"}`,
        `Term Max: ${row.term_max ?? "N/A"}`,
        `Country: ${row.country ?? "N/A"}`,
    ].join("\n");
}
async function ingestAllProducts(db) {
    const products = await db.query(`select id, name, category, interest_min, interest_max, term_min, term_max, country
     from lender_products`);
    for (const product of products.rows) {
        await (0, knowledge_service_1.embedAndStore)(db, toProductKnowledge(product), "product", product.id);
    }
}
async function ingestProductById(db, productId) {
    const result = await db.query(`select id, name, category, interest_min, interest_max, term_min, term_max, country
     from lender_products
     where id = $1
     limit 1`, [productId]);
    const product = result.rows[0];
    if (!product) {
        return;
    }
    await (0, knowledge_service_1.embedAndStore)(db, toProductKnowledge(product), "product", product.id);
}
