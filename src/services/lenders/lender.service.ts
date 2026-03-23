import { db } from "../../lib/db";

export const lenderService = {
  async list() {
    return db.lender.findMany();
  },

  async byId(id: string) {
    return db.lender.findUnique({
      where: { id },
      include: { products: true },
    });
  },



  async withProducts(id: string) {
    return db.lender.findUnique({
      where: { id },
      include: { products: true },
    });
  },

  async create(data: { name: string }) {
    return db.lender.create({ data });
  },

  async update(id: string, data: { name?: string }) {
    return db.lender.update({
      where: { id },
      data,
    });
  },
};
