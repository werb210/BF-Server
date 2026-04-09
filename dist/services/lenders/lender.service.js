import { getPrisma } from "../../lib/db.js";
export const lenderService = {
    async list() {
        const prisma = (await getPrisma());
        return prisma.lender.findMany();
    },
    async byId(id) {
        const prisma = (await getPrisma());
        return prisma.lender.findUnique({
            where: { id },
            include: { products: true },
        });
    },
    async withProducts(id) {
        const prisma = (await getPrisma());
        return prisma.lender.findUnique({
            where: { id },
            include: { products: true },
        });
    },
    async create(data) {
        const prisma = (await getPrisma());
        return prisma.lender.create({ data });
    },
    async update(id, data) {
        const prisma = (await getPrisma());
        return prisma.lender.update({
            where: { id },
            data,
        });
    },
};
