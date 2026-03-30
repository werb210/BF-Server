"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lenderService = void 0;
const db_1 = require("../../lib/db");
exports.lenderService = {
    async list() {
        return db_1.db.lender.findMany();
    },
    async byId(id) {
        return db_1.db.lender.findUnique({
            where: { id },
            include: { products: true },
        });
    },
    async withProducts(id) {
        return db_1.db.lender.findUnique({
            where: { id },
            include: { products: true },
        });
    },
    async create(data) {
        return db_1.db.lender.create({ data });
    },
    async update(id, data) {
        return db_1.db.lender.update({
            where: { id },
            data,
        });
    },
};
