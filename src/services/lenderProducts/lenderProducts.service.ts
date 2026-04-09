import { getPrisma } from "../../lib/db.js";
import {
  CreateLenderProductDTO,
  UpdateLenderProductDTO,
} from "../../types/dto/lenderProduct.dto.js";

export const lenderProductsService = {
  async list() {
    const prisma = (await getPrisma()) as any;
    return prisma.lenderProduct.findMany();
  },

  async create(data: CreateLenderProductDTO) {
    const prisma = (await getPrisma()) as any;
    return prisma.lenderProduct.create({ data });
  },

  async update(id: string, data: UpdateLenderProductDTO) {
    const prisma = (await getPrisma()) as any;
    return prisma.lenderProduct.update({
      where: { id },
      data,
    });
  },
};
