import { getPrisma } from "../../lib/db.js";
export const lenderProductsService = {
    async list() {
        const prisma = (await getPrisma());
        return prisma.lenderProduct.findMany();
    },
    async create(data) {
        const prisma = (await getPrisma());
        return prisma.lenderProduct.create({ data });
    },
    async update(id, data) {
        const prisma = (await getPrisma());
        return prisma.lenderProduct.update({
            where: { id },
            data,
        });
    },
};
