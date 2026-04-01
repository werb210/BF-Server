import { getPrisma } from "../../lib/db";

export const lenderService = {
  async list() {
    const prisma = (await getPrisma()) as any;
    return prisma.lender.findMany();
  },

  async byId(id: string) {
    const prisma = (await getPrisma()) as any;
    return prisma.lender.findUnique({
      where: { id },
      include: { products: true },
    });
  },

  async withProducts(id: string) {
    const prisma = (await getPrisma()) as any;
    return prisma.lender.findUnique({
      where: { id },
      include: { products: true },
    });
  },

  async create(data: { name: string }) {
    const prisma = (await getPrisma()) as any;
    return prisma.lender.create({ data });
  },

  async update(id: string, data: { name?: string }) {
    const prisma = (await getPrisma()) as any;
    return prisma.lender.update({
      where: { id },
      data,
    });
  },
};
