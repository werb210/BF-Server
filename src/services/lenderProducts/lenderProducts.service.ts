export const lenderProductsService = {
  async list() {
    return [];
  },

  async create(data: any) {
    return { success: true, ...data };
  },

  async update(id: string, data: any) {
    return { id, ...data };
  },
};
